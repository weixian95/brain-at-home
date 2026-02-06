const http = require('node:http')

const { config } = require('./lib/config')
const { FileStore } = require('./lib/storage')
const { withChatLock } = require('./lib/locks')
const {
  buildPromptMessages,
  shouldUpdateMemory,
  updateMemory,
} = require('./lib/memory')
const {
  estimateTokens,
  readJsonBody,
  respondJson,
  setCors,
  trimToCharBudget,
} = require('./lib/utils')
const { callOllamaChat, listOllamaModels } = require('./lib/ollama')

const store = new FileStore(config.DATA_DIR, config.CHATS_DIR)

const server = http.createServer(async (req, res) => {
  try {
    setCors(res)

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    if (!req.url) {
      respondJson(res, 400, { error: 'Missing request URL.' })
      return
    }

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

    if (url.pathname === '/health') {
      respondJson(res, 200, {
        ok: true,
        upstream: config.OLLAMA_URL,
        time: new Date().toISOString(),
        storage: { type: 'file', path: config.CHATS_DIR },
      })
      return
    }

    if (
      (url.pathname === '/api/tags' || url.pathname === '/api/models') &&
      req.method === 'GET'
    ) {
      const models = await listOllamaModels({ baseUrl: config.OLLAMA_URL })
      respondJson(res, 200, { models })
      return
    }

    if (url.pathname === '/api/chats' && req.method === 'GET') {
      await handleListChats(req, res, url)
      return
    }

    if (url.pathname.startsWith('/api/chats/') && req.method === 'GET') {
      await handleChatRead(req, res, url)
      return
    }

    if (url.pathname.startsWith('/api/chats/') && req.method === 'DELETE') {
      await handleChatDelete(req, res, url)
      return
    }

    if (url.pathname === '/api/chat' && req.method === 'POST') {
      await handleChat(req, res)
      return
    }

    respondJson(res, 404, { error: 'Not found.' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.'
    respondJson(res, 500, { error: message })
  }
})

server.listen(config.PORT, config.BIND_HOST, () => {
  console.log(`Gateway listening on http://${config.BIND_HOST}:${config.PORT}`)
  console.log(`Ollama upstream: ${config.OLLAMA_URL}`)
})

async function handleChat(req, res) {
  let payload
  try {
    payload = await readJsonBody(req, config.MAX_BODY_BYTES)
  } catch (error) {
    respondJson(res, 400, { error: 'Invalid JSON body.' })
    return
  }

  if (!payload || typeof payload !== 'object') {
    respondJson(res, 400, { error: 'Missing request body.' })
    return
  }

  const {
    user_id: userId,
    chat_id: chatId,
    model_id: modelId,
    prompt,
    message_id: messageId,
    client_ts: clientTs,
    stream,
  } = payload

  const missing = []
  if (!isNonEmptyString(userId)) missing.push('user_id')
  if (!isNonEmptyString(chatId)) missing.push('chat_id')
  if (!isNonEmptyString(prompt)) missing.push('prompt')
  if (!isNonEmptyString(messageId)) missing.push('message_id')
  if (!isNonEmptyString(modelId) && !config.DEFAULT_MODEL_ID) missing.push('model_id')

  if (missing.length) {
    respondJson(res, 400, { error: `Missing fields: ${missing.join(', ')}` })
    return
  }

  const useStream = isStreamRequested(stream)
  const chatKey = `${userId}:${chatId}`
  await withChatLock(chatKey, async () => {
    const record = store.getOrCreateChat(userId, chatId)

    if (record.idempotency && record.idempotency[messageId]) {
      const cachedAnswer = record.idempotency[messageId].answer
      if (useStream) {
        startStreamResponse(res)
        writeNdjson(res, {
          message: { role: 'assistant', content: cachedAnswer },
          done: true,
        })
        res.end()
        return
      }

      respondJson(res, 200, { chat_id: chatId, answer: cachedAnswer })
      return
    }

    const requestTs = Date.now()
    const messageTs = Number.isFinite(clientTs) ? clientTs : requestTs

    const promptMessages = buildPromptMessages({
      systemPrompt: config.SYSTEM_PROMPT,
      summary: record.summary,
      facts: record.facts,
      rawMessages: record.raw_messages,
      newPrompt: prompt,
      budgets: {
        summary: config.SUMMARY_TOKEN_BUDGET,
        facts: config.FACTS_TOKEN_BUDGET,
        recent: config.RECENT_TOKEN_BUDGET,
      },
      recentTurns: config.RECENT_TURNS,
    })

    if (!useStream) {
      const answer = await callOllamaChat({
        baseUrl: config.OLLAMA_URL,
        model: modelId || config.DEFAULT_MODEL_ID,
        messages: promptMessages,
        stream: false,
      })
      const answerTs = Date.now()

      await finalizeChatTurn({
        record,
        prompt,
        messageId,
        messageTs,
        answer,
        answerTs,
      })

      respondJson(res, 200, { chat_id: chatId, answer })
      return
    }

    try {
      const { answer, completed } = await streamOllamaChat({
        res,
        baseUrl: config.OLLAMA_URL,
        model: modelId || config.DEFAULT_MODEL_ID,
        messages: promptMessages,
      })

      if (!completed || !answer) {
        return
      }

      const answerTs = Date.now()
      await finalizeChatTurn({
        record,
        prompt,
        messageId,
        messageTs,
        answer,
        answerTs,
      })
    } catch (error) {
      if (!res.headersSent) {
        respondJson(res, 502, { error: error.message })
      } else if (!res.writableEnded) {
        writeNdjson(res, { error: error.message || 'Stream failed', done: true })
        res.end()
      }
    }
  })
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isStreamRequested(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function getFirstUserPrompt(record, fallback) {
  if (record && Array.isArray(record.raw_messages)) {
    const firstUser = record.raw_messages.find(
      (message) => message.role === 'user' && message.content
    )
    if (firstUser && firstUser.content) {
      return String(firstUser.content)
    }
  }
  return fallback ? String(fallback) : ''
}

function startStreamResponse(res) {
  if (res.headersSent) return
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
}

function writeNdjson(res, payload) {
  if (res.writableEnded) return
  res.write(`${JSON.stringify(payload)}\n`)
}

async function streamOllamaChat({ res, baseUrl, model, messages }) {
  const endpoint = new URL('/api/chat', baseUrl)
  const controller = new AbortController()
  let aborted = false
  let buffer = ''
  let answer = ''
  let sawDone = false

  const onClose = () => {
    aborted = true
    controller.abort()
  }

  res.on('close', onClose)

  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal: controller.signal,
  })

  if (!upstream.ok) {
    const text = await upstream.text()
    res.off('close', onClose)
    throw new Error(`Ollama error ${upstream.status}: ${text}`)
  }

  if (!upstream.body) {
    res.off('close', onClose)
    throw new Error('Ollama streaming body missing.')
  }

  startStreamResponse(res)

  const reader = upstream.body.getReader()

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = Buffer.from(value).toString('utf-8')
    if (!res.writableEnded) {
      res.write(chunk)
    }
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop() || ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed)
        if (parsed && parsed.message && typeof parsed.message.content === 'string') {
          answer += parsed.message.content
        }
        if (parsed && parsed.done === true) {
          sawDone = true
        }
      } catch {
        // Ignore parsing errors for partial lines.
      }
    }
  }

  const trailing = buffer.trim()
  if (trailing) {
    try {
      const parsed = JSON.parse(trailing)
      if (parsed && parsed.message && typeof parsed.message.content === 'string') {
        answer += parsed.message.content
      }
      if (parsed && parsed.done === true) {
        sawDone = true
      }
    } catch {
      // ignore
    }
  }

  if (!res.writableEnded) {
    res.end()
  }

  res.off('close', onClose)

  return {
    answer,
    completed: !aborted && (sawDone || answer.length > 0),
  }
}

async function finalizeChatTurn({
  record,
  prompt,
  messageId,
  messageTs,
  answer,
  answerTs,
}) {
  record.raw_messages.push({
    role: 'user',
    content: prompt,
    ts: messageTs,
    message_id: messageId,
  })
  record.raw_messages.push({
    role: 'assistant',
    content: answer,
    ts: answerTs,
  })

  record.last_message_ts = answerTs
  record.last_updated_ts = answerTs

  record.idempotency = record.idempotency || {}
  record.idempotency[messageId] = { answer, ts: answerTs }

  if (!record.title) {
    const firstPrompt = getFirstUserPrompt(record, prompt)
    if (firstPrompt) {
      try {
        const generated = await generateTitle(firstPrompt)
        if (generated) {
          record.title = generated
        }
      } catch (error) {
        console.error('Title generation failed:', error)
      }
    }
  }

  await maybeUpdateMemory(record, answerTs)
  store.saveChat(record)
}

async function maybeUpdateMemory(record, now) {
  const summaryAnchor = getLastSummaryTs(record)
  const messagesSince = record.raw_messages.filter(
    (message) => message.ts > summaryAnchor
  )
  const turnsSince = messagesSince.filter((message) => message.role === 'user').length
  const tokensSince = estimateTokens(
    messagesSince.map((message) => message.content).join('\n')
  )

  if (
    shouldUpdateMemory({
      turnsSinceSummary: turnsSince,
      tokensSinceSummary: tokensSince,
      config,
    })
  ) {
    try {
      const updated = await updateMemory({
        baseUrl: config.OLLAMA_URL,
        memoryModelId: config.MEMORY_MODEL_ID,
        previousSummary: record.summary,
        previousFacts: record.facts,
        messagesSince,
        summaryBudget: config.SUMMARY_TOKEN_BUDGET,
        factsBudget: config.FACTS_TOKEN_BUDGET,
        inputTokenBudget: config.MEMORY_UPDATE_INPUT_TOKENS,
      })

      if (updated) {
        record.summary = updated.summary
        record.facts = updated.facts
        record.last_summary_ts = now
      }
    } catch (error) {
      console.error('Memory update failed:', error)
    }
  }
}

function getLastMessageTs(record) {
  if (!record) return 0
  if (Number.isFinite(record.last_message_ts) && record.last_message_ts > 0) {
    return record.last_message_ts
  }
  if (!Array.isArray(record.raw_messages)) return 0
  return record.raw_messages.reduce((max, message) => {
    const ts = Number.isFinite(message.ts) ? message.ts : 0
    return ts > max ? ts : max
  }, 0)
}

function getLastUpdatedTs(record) {
  if (!record) return 0
  if (Number.isFinite(record.last_updated_ts) && record.last_updated_ts > 0) {
    return record.last_updated_ts
  }
  return getLastMessageTs(record)
}

function getLastSummaryTs(record) {
  if (!record) return 0
  if (Number.isFinite(record.last_summary_ts) && record.last_summary_ts > 0) {
    return record.last_summary_ts
  }
  const hasLastMessage =
    Number.isFinite(record.last_message_ts) && record.last_message_ts > 0
  if (!hasLastMessage) {
    return Number.isFinite(record.last_updated_ts) ? record.last_updated_ts : 0
  }
  return 0
}

async function generateTitle(prompt) {
  const systemPrompt =
    'You generate concise chat titles. ' +
    'Return only the title text, no quotes, no markdown, no extra commentary.'
  const userPrompt = [
    'Create a short, specific title (max 8 words).',
    'Avoid punctuation at the end.',
    'Use the user intent, not the exact sentence.',
    '',
    `First user message: ${prompt}`,
  ].join('\n')

  const response = await callOllamaChat({
    baseUrl: config.OLLAMA_URL,
    model: config.TITLE_MODEL_ID || config.MEMORY_MODEL_ID,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
  })

  const cleaned = String(response || '')
    .split('\n')[0]
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[.?!]+$/, '')
    .trim()

  if (!cleaned) return ''
  return trimToCharBudget(cleaned, config.TITLE_MAX_CHARS)
}

async function handleListChats(_req, res, url) {
  const userId = url.searchParams.get('user_id')
  if (!isNonEmptyString(userId)) {
    respondJson(res, 400, { error: 'Missing user_id.' })
    return
  }

  const chats = store.listChatsForUser(userId).map((chat) => ({
    ...chat,
    title: chat.title || 'New chat',
  }))
  respondJson(res, 200, { user_id: userId, chats })
}

async function handleChatRead(_req, res, url) {
  const userId = url.searchParams.get('user_id')
  if (!isNonEmptyString(userId)) {
    respondJson(res, 400, { error: 'Missing user_id.' })
    return
  }

  const path = url.pathname.replace(/^\/api\/chats\//, '')
  const parts = path.split('/').filter(Boolean)
  const chatId = decodeURIComponent(parts[0] || '')

  if (!isNonEmptyString(chatId)) {
    respondJson(res, 404, { error: 'Not found.' })
    return
  }

  const record = store.loadChat(userId, chatId)
  if (!record) {
    respondJson(res, 404, { error: 'Chat not found.' })
    return
  }

  const title = record.title || 'New chat'

  const lastMessageTs = getLastMessageTs(record)

  if (parts.length === 1) {
    respondJson(res, 200, {
      user_id: record.user_id,
      chat_id: record.chat_id,
      title,
      summary: record.summary || '',
      facts: Array.isArray(record.facts) ? record.facts : [],
      last_updated_ts: getLastUpdatedTs(record),
      last_message_ts: lastMessageTs,
      last_summary_ts: getLastSummaryTs(record),
      raw_count: Array.isArray(record.raw_messages)
        ? record.raw_messages.length
        : 0,
    })
    return
  }

  if (parts.length === 2 && parts[1] === 'messages') {
    const offset = Number.parseInt(url.searchParams.get('offset') || '0', 10)
    const limit = Number.parseInt(url.searchParams.get('limit') || '0', 10)
    const raw = Array.isArray(record.raw_messages) ? record.raw_messages : []
    const safeOffset = Number.isFinite(offset) && offset > 0 ? offset : 0
    const sliced =
      Number.isFinite(limit) && limit > 0
        ? raw.slice(safeOffset, safeOffset + limit)
        : raw.slice(safeOffset)

    respondJson(res, 200, {
      user_id: record.user_id,
      chat_id: record.chat_id,
      total: raw.length,
      offset: safeOffset,
      limit: Number.isFinite(limit) && limit > 0 ? limit : null,
      messages: sliced,
    })
    return
  }

  respondJson(res, 404, { error: 'Not found.' })
}

async function handleChatDelete(_req, res, url) {
  const userId = url.searchParams.get('user_id')
  if (!isNonEmptyString(userId)) {
    respondJson(res, 400, { error: 'Missing user_id.' })
    return
  }

  const path = url.pathname.replace(/^\/api\/chats\//, '')
  const parts = path.split('/').filter(Boolean)
  const chatId = decodeURIComponent(parts[0] || '')

  if (!isNonEmptyString(chatId)) {
    respondJson(res, 404, { error: 'Not found.' })
    return
  }

  const removed = store.deleteChat(userId, chatId)
  if (!removed) {
    respondJson(res, 404, { error: 'Chat not found.' })
    return
  }

  respondJson(res, 200, { ok: true, user_id: userId, chat_id: chatId })
}
