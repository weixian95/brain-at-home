const http = require('node:http')

const { config } = require('../lib/config')
const { FileStore } = require('../lib/storage')
const { withChatLock } = require('../lib/locks')
const {
  buildPromptMessages,
  selectRecentUserMessages,
  shouldUpdateMemory,
  updateMemory,
} = require('../lib/memory')
const {
  estimateTokens,
  readJsonBody,
  respondJson,
  setCors,
  trimToCharBudget,
  extractJson,
} = require('../lib/utils')
const { callOllamaChat, listOllamaModels } = require('../lib/ollama')
const { runHighLlm } = require('../lib/llm_queue')
const { generateTopic } = require('../lib/topic')
// Web agent routing is controlled by client input (use_web/web_search).
const { callWebAgent, streamWebAgent } = require('../agent/client')

const store = new FileStore(config.DATA_DIR, config.CHATS_DIR)
const chatListeners = new Map()
const SEARCH_QUERY_SYSTEM_PROMPT =
  'You create search engine queries for Brave Search. ' +
  'Use the latest user prompt, and only use prior prompts if the latest lacks context. ' +
  'Return only the query text (no quotes, no punctuation, no extra words). ' +
  'Keep it within 10 words.'
const QUERY_MAX_WORDS = 10
const QUERY_CONTEXT_TURNS = 3
const SHORT_TASK_OPTIONS = { temperature: 0.2 }
const QUERY_TIMEOUT_MS = 6000
const INFO_SEEKING_TIMEOUT_MS = 6000
const POLISH_TIMEOUT_MS = 20000
const POLISH_MIN_CHARS = 1500
const TOPIC_TIMEOUT_MS = 0
const POST_ANSWER_TASK_TIMEOUT_MS = 80000
const TITLE_TIMEOUT_MS = 0
const TITLE_LLM_OPTIONS = { temperature: 0.2, repeat_penalty: 1.2 }
const TITLE_LLM_RETRY_OPTIONS = { temperature: 0.7, repeat_penalty: 1.2 }
const TITLE_MAX_WORDS = 6

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

    if (
      url.pathname.startsWith('/api/chats/') &&
      url.pathname.endsWith('/stream') &&
      req.method === 'GET'
    ) {
      await handleChatStream(req, res, url)
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
    if (res.headersSent) {
      if (!res.writableEnded) {
        res.end()
      }
      return
    }
    respondJson(res, 500, { error: message })
  }
})

server.listen(config.PORT, config.BIND_HOST, () => {
  console.log(`Gateway listening on http://${config.BIND_HOST}:${config.PORT}`)
  console.log(`Ollama upstream: ${config.OLLAMA_URL}`)
  if (config.WEB_AGENT_URL) {
    console.log(`Web agent: ${config.WEB_AGENT_URL}`)
  } else {
    console.log('Web agent: disabled (WEB_AGENT_URL not set)')
  }
})

async function handleChat(req, res) {
  try {
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
      use_web: useWeb,
      web_search: webSearch,
    } = payload

    const missing = []
    if (!isNonEmptyString(userId)) missing.push('user_id')
    if (!isNonEmptyString(chatId)) missing.push('chat_id')
    if (!isNonEmptyString(prompt)) missing.push('prompt')
    if (!isNonEmptyString(messageId)) missing.push('message_id')
    if (!isNonEmptyString(modelId) && !config.DEFAULT_MODEL_ID) {
      missing.push('model_id')
    }

    if (missing.length) {
      respondJson(res, 400, { error: `Missing fields: ${missing.join(', ')}` })
      return
    }

    const useStream = isStreamRequested(stream)
    const override = parseBooleanOverride(
      typeof useWeb !== 'undefined' ? useWeb : webSearch
    )

    if (override === null) {
      if (useStream) {
        startStreamResponse(res)
        writeNdjson(res, {
          stage: 'error',
          error: 'Missing use_web. Client must choose local vs web agent.',
          done: true,
        })
        res.end()
      } else {
        respondJson(res, 400, {
          error: 'Missing use_web. Client must choose local vs web agent.',
        })
      }
      return
    }

    const localModelId = modelId || config.DEFAULT_MODEL_ID
    const explicitSearch = isExplicitSearchRequest(prompt)
    const route = await determineInfoSeeking({
      prompt,
      modelId: localModelId,
    })
    const infoSeeking = route.infoSeeking
    const shouldUseWeb = Boolean(
      override && (explicitSearch || route.needsWeb || infoSeeking)
    )
    const webReason = override
      ? shouldUseWeb
        ? explicitSearch
          ? 'explicit_search'
          : route.reason || 'classifier'
        : 'non_info_prompt'
      : 'client_override_off'
    const webDecision = { use: shouldUseWeb, reasons: [webReason] }
    const chatKey = `${userId}:${chatId}`
    await withChatLock(chatKey, async () => {
      const record = store.getOrCreateChat(userId, chatId)

    if (record.idempotency && record.idempotency[messageId]) {
      const cached = record.idempotency[messageId]
      const cachedAnswer = cached.answer
      const cachedSources = Array.isArray(cached.sources) ? cached.sources : []
      if (useStream) {
        startStreamResponse(res)
        if (cachedSources.length) {
          writeNdjson(res, { stage: 'sources', sources: cachedSources, done: false })
        }
        writeNdjson(res, {
          message: { role: 'assistant', content: cachedAnswer },
          done: true,
        })
        res.end()
        return
      }

      respondJson(res, 200, {
        chat_id: chatId,
        answer: cachedAnswer,
        sources: cachedSources,
        topic: record.topic || '',
      })
      return
    }

    const requestTs = Date.now()
    const messageTs = Number.isFinite(clientTs) ? clientTs : requestTs
    if (useStream) {
      startStreamResponse(res)
      writeNdjson(res, {
        stage: 'routing',
        content: 'Selecting information acquisition strategy.',
        done: false,
      })
      writeNdjson(res, {
        stage: 'routing_decision',
        use_web: Boolean(webDecision && webDecision.use),
        source: 'client',
        reason: webReason,
        confidence: route.confidence,
        done: false,
      })
      if (override && !infoSeeking) {
        writeNdjson(res, {
          stage: 'analysis',
          content: 'Web search skipped for non-information prompt.',
          done: false,
        })
      }
    }

    const budgets = {
      summary: config.SUMMARY_TOKEN_BUDGET,
      facts: config.FACTS_TOKEN_BUDGET,
      recent: config.RECENT_TOKEN_BUDGET,
    }

    const basePromptMessages = buildPromptMessages({
      systemPrompt: config.SYSTEM_PROMPT,
      summary: record.summary,
      facts: record.facts,
      rawMessages: record.raw_messages,
      newPrompt: prompt,
      budgets,
      recentTurns: config.RECENT_TURNS,
    })
    const topic = typeof record.topic === 'string' ? record.topic : ''
    const localPromptMessages = injectNonInfoHint(
      injectTopicIntoMessages(basePromptMessages, topic),
      infoSeeking
    )
    if (webDecision.use) {
      if (useStream) {
        writeNdjson(res, {
          stage: 'analysis',
          content: 'Generating search query.',
          done: false,
        })
      }

      let query = ''
      let queryTimedOut = false
      try {
        query = await runHighLlm(() =>
          generateSearchQuery({
            baseUrl: config.OLLAMA_URL,
            modelId: localModelId,
            rawMessages: record.raw_messages,
            prompt,
          })
        )
      } catch (error) {
        queryTimedOut = error instanceof Error && error.message.includes('timed out')
        query = ''
      }

      if (!query) {
        query = fallbackSearchQuery(prompt)
        if (useStream && queryTimedOut) {
          writeNdjson(res, {
            stage: 'analysis',
            content: 'Query generation timed out; using prompt as search query.',
            done: false,
          })
        }
      }

      let sources = []
      let sourcesSent = false
      if (!config.WEB_AGENT_URL) {
        if (useStream) {
          writeNdjson(res, {
            stage: 'web_agent_unavailable',
            reason: 'WEB_AGENT_URL not configured',
            done: false,
          })
        }
      } else if (useStream) {
        try {
          const result = await streamWebAgent({
            query,
            userId,
            chatId,
            messageId,
            clientTs: messageTs,
            modelId: localModelId,
            onEvent: (event) => {
              if (event && typeof event === 'object') {
                const output = { ...event }
                if (output.done === true) {
                  output.done = false
                }
                writeNdjson(res, output)
              }
            },
          })
          sources = Array.isArray(result.sources) ? result.sources : []
          const sawSources = Boolean(result.sawSources)
          if (!result.completed) {
            writeNdjson(res, {
              stage: 'web_agent_failed',
              reason: 'web agent did not complete',
              done: false,
            })
          }
          if (!sawSources && sources.length && !res.writableEnded) {
            writeNdjson(res, { stage: 'sources', sources, done: false })
            sourcesSent = true
          }
        } catch (error) {
          writeNdjson(res, {
            stage: 'web_agent_failed',
            reason: error instanceof Error ? error.message : 'web agent error',
            done: false,
          })
        }
      } else {
        try {
          const result = await callWebAgent({
            query,
            userId,
            chatId,
            messageId,
            clientTs: messageTs,
            modelId: localModelId,
          })
          sources = Array.isArray(result.sources) ? result.sources : []
        } catch {
          sources = []
        }
      }

      const promptWithSources = injectSourcesIntoMessages(
        localPromptMessages,
        sources,
        prompt,
        infoSeeking
      )

      if (useStream) {
        if (
          Array.isArray(sources) &&
          sources.length &&
          !sourcesSent &&
          !res.writableEnded
        ) {
          writeNdjson(res, { stage: 'sources', sources, done: false })
          sourcesSent = true
        }
        writeNdjson(res, {
          stage: 'analysis',
          content: sources.length
            ? `Using ${sources.length} web sources.`
            : 'No web sources available; answering locally.',
          done: false,
        })

        const { answer, completed } = await runHighLlm(() =>
          streamOllamaChat({
            res,
            baseUrl: config.OLLAMA_URL,
            model: localModelId,
            messages: promptWithSources,
            end: false,
          })
        )

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
          modelId: localModelId,
          sources,
          deferHeavy: true,
        })

        if (!res.writableEnded) {
          res.end()
        }
      void runPostAnswerUpdates({
        record,
        answer,
        answerTs,
        messageTs,
        prompt,
        modelId: localModelId,
        infoSeeking,
        routeConfidence: route.confidence,
        sources,
        messageId,
      })
      return
    }

      const answer = await runHighLlm(() =>
        callOllamaChat({
          baseUrl: config.OLLAMA_URL,
          model: localModelId,
          messages: promptWithSources,
          stream: false,
        })
      )
      const answerTs = Date.now()

      await finalizeChatTurn({
        record,
        prompt,
        messageId,
        messageTs,
        answer,
        answerTs,
        modelId: localModelId,
        sources,
        deferHeavy: true,
      })

      respondJson(res, 200, {
        chat_id: chatId,
        answer,
        sources,
        topic: record.topic || '',
      })
      await runPostAnswerUpdates({
        record,
        answer,
        answerTs,
        messageTs,
        prompt,
        modelId: localModelId,
        infoSeeking,
        routeConfidence: route.confidence,
        sources,
        messageId,
      })
      return
    }

    const promptMessages = localPromptMessages

    if (!useStream) {
      const answer = await runHighLlm(() =>
        callOllamaChat({
          baseUrl: config.OLLAMA_URL,
          model: modelId || config.DEFAULT_MODEL_ID,
          messages: promptMessages,
          stream: false,
        })
      )
      const answerTs = Date.now()

      await finalizeChatTurn({
        record,
        prompt,
        messageId,
        messageTs,
        answer,
        answerTs,
        modelId: localModelId,
        sources: [],
        deferHeavy: true,
      })

      respondJson(res, 200, { chat_id: chatId, answer, topic: record.topic || '' })
      await runPostAnswerUpdates({
        record,
        answer,
        answerTs,
        messageTs,
        prompt,
        modelId: localModelId,
        infoSeeking,
        routeConfidence: route.confidence,
        sources: [],
        messageId,
      })
      return
    }

    try {
      startStreamResponse(res)
      const digest = trimToCharBudget(
        String(prompt || '').replace(/\s+/g, ' ').trim(),
        180
      )
      if (digest) {
        writeNdjson(res, { stage: 'digest_prompt', content: digest, done: false })
      }
      writeNdjson(res, {
        stage: 'analysis',
        content: 'Using local model.',
        done: false,
      })

      const { answer, completed } = await runHighLlm(() =>
        streamOllamaChat({
          res,
          baseUrl: config.OLLAMA_URL,
          model: modelId || config.DEFAULT_MODEL_ID,
          messages: promptMessages,
          end: false,
        })
      )

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
        modelId: localModelId,
        sources: [],
        deferHeavy: true,
      })
      if (!res.writableEnded) {
        res.end()
      }
      void runPostAnswerUpdates({
        record,
        answer,
        answerTs,
        messageTs,
        prompt,
        modelId: localModelId,
        infoSeeking,
        routeConfidence: route.confidence,
        sources: [],
        messageId,
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
  } finally {
    // no-op
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isStreamRequested(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
}

function parseBooleanOverride(value) {
  if (value === undefined || value === null) return null
  if (value === true || value === false) return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    const lowered = value.trim().toLowerCase()
    if (['true', 'yes', 'on'].includes(lowered)) return true
    if (['false', 'no', 'off'].includes(lowered)) return false
  }
  return null
}

async function updateTopicAfterAnswer({ record, prompt, messageTs, modelId }) {
  if (!record) return ''
  const currentTopic = typeof record.topic === 'string' ? record.topic : ''
  const recentMessages = collectRecentTopicMessages(record, prompt, 4)

  let nextTopic = currentTopic
  let timedOut = false
  try {
    console.log('[topic] request', {
      modelId,
      timeoutMs: TOPIC_TIMEOUT_MS,
      maxWords: config.TOPIC_MAX_WORDS,
      currentTopic,
      promptPreview: summarizePrompt(prompt, 120),
    })
    const topicResult = await runHighLlm(() =>
      generateTopic({
        baseUrl: config.OLLAMA_URL,
        modelId,
        currentTopic,
        recentPrompts: recentMessages,
        maxWords: config.TOPIC_MAX_WORDS,
        timeoutMs: TOPIC_TIMEOUT_MS,
      })
    )
    const candidate =
      topicResult && typeof topicResult.topic === 'string' ? topicResult.topic : ''
    if (candidate) {
      const same =
        currentTopic &&
        candidate.trim().toLowerCase() === currentTopic.trim().toLowerCase()
      if (!same) {
        nextTopic = candidate
      }
    }
  } catch (error) {
    timedOut =
      error instanceof Error && typeof error.message === 'string'
        ? error.message.includes('timed out')
        : false
    if (!timedOut) {
      console.error('Topic generation failed:', error)
    }
  }

  if (!nextTopic) {
    nextTopic = fallbackTopicFromPrompt(prompt, currentTopic, config.TOPIC_MAX_WORDS)
  }

  record.topic = nextTopic || currentTopic || ''
  record.last_topic_ts = messageTs

  if (timedOut) {
    console.warn('[topic] generation timed out; fallback used')
  }

  return record.topic
}

function collectRecentTopicMessages(record, fallbackPrompt, limit) {
  const maxItems = Number.isFinite(limit) ? Math.max(1, limit) : 4
  const raw = Array.isArray(record?.raw_messages) ? record.raw_messages : []
  const recent = raw
    .filter((message) => message && typeof message.content === 'string')
    .slice(-maxItems)
    .map((message) => {
      const role = message.role === 'assistant' ? 'assistant' : 'user'
      const content = trimWords(
        String(message.content || '').replace(/\s+/g, ' ').trim(),
        20
      )
      return content ? `${role}: ${content}` : ''
    })
    .filter(Boolean)
  if (recent.length) return recent
  const fallback = String(fallbackPrompt || '').replace(/\s+/g, ' ').trim()
  return fallback ? [fallback] : []
}

function trimWords(value, maxWords) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const words = text.split(' ').filter(Boolean)
  if (!Number.isFinite(maxWords) || maxWords <= 0) return text
  return words.slice(0, maxWords).join(' ')
}

function fallbackTopicFromPrompt(prompt, currentTopic, maxWords) {
  const cleaned = normalizePromptSeed(prompt)
  if (!cleaned) return currentTopic || ''
  if (isConversationalPrompt(cleaned)) {
    return currentTopic || ''
  }
  const words = cleaned.split(' ').filter(Boolean)
  if (words.length <= 2 && currentTopic) {
    return currentTopic
  }
  const limited = words.slice(0, Math.max(1, maxWords || 6)).join(' ')
  return limited
}

function fallbackTitleFromPrompt(prompt) {
  const cleaned = normalizeTitleSeed(prompt)
  if (!cleaned) return ''
  const words = cleaned.split(' ').filter(Boolean)
  const limited = words.slice(0, 8).join(' ')
  return trimToCharBudget(limited, config.TITLE_MAX_CHARS)
}

function normalizeTitleSeed(prompt) {
  const cleaned = String(prompt || '')
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const stripped = stripPromptLeadCase(cleaned)
  return stripped || cleaned
}

function normalizePromptSeed(prompt) {
  const cleaned = String(prompt || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return ''
  const stripped = stripPromptLead(cleaned)
  return stripped || cleaned
}

function stripPromptLead(text) {
  let cleaned = String(text || '').trim()
  const patterns = [
    /^please\s+/,
    /^(do you know( about)?|do you remember|do you have info on)\s+/,
    /^(tell me about|tell me|explain)\s+/,
    /^(what is|who is|where is|when is|why is|how is|how to|how do i|how do you)\s+/,
    /^(can you|could you|would you|will you)\s+/,
    /^(find( me)?|search( for)?|look up)\s+/,
    /^(give me|list|show me)\s+/,
  ]
  for (const pattern of patterns) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '').trim()
    }
  }
  return cleaned
}

function stripPromptLeadCase(text) {
  let cleaned = String(text || '').trim()
  const patterns = [
    /^please\s+/i,
    /^(do you know( about)?|do you remember|do you have info on)\s+/i,
    /^(tell me about|tell me|explain)\s+/i,
    /^(what is|who is|where is|when is|why is|how is|how to|how do i|how do you)\s+/i,
    /^(can you|could you|would you|will you)\s+/i,
    /^(find( me)?|search( for)?|look up)\s+/i,
    /^(give me|list|show me)\s+/i,
  ]
  for (const pattern of patterns) {
    if (pattern.test(cleaned)) {
      cleaned = cleaned.replace(pattern, '').trim()
    }
  }
  return cleaned
}

async function generateSearchQuery({
  baseUrl,
  modelId,
  rawMessages,
  prompt,
}) {
  const recentPrompts = collectQueryPrompts(rawMessages, prompt, QUERY_CONTEXT_TURNS)
  const latestPrompt = recentPrompts[recentPrompts.length - 1] || String(prompt || '')
  const priorPrompts = recentPrompts.slice(0, -1)

  const userPrompt = [
    'Latest user prompt (always use):',
    `1) ${latestPrompt || '(empty)'}`,
    '',
    'Previous prompts (use only if needed for context):',
    priorPrompts.length
      ? priorPrompts.map((text, index) => `${index + 2}) ${text}`).join('\n')
      : '(none)',
    '',
    'Return only the search query.',
  ].join('\n')

  const response = await callOllamaChat({
    baseUrl,
    model: modelId,
    messages: [
      { role: 'system', content: SEARCH_QUERY_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    timeoutMs: QUERY_TIMEOUT_MS,
    options: SHORT_TASK_OPTIONS,
  })

  return normalizeSearchQuery(response)
}

function normalizeSearchQuery(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const firstLine = text.split('\n')[0].trim()
  const cleaned = firstLine
    .replace(/^["'“”]+|["'“”]+$/g, '')
    .replace(/[.?!]+$/, '')
    .trim()
  return trimQueryWords(cleaned, QUERY_MAX_WORDS)
}

function collectQueryPrompts(rawMessages, latestPrompt, maxPrompts) {
  const desired = Math.max(1, maxPrompts || 1)
  const previousCount = Math.max(0, desired - 1)
  const previous = selectRecentUserMessages(
    rawMessages,
    previousCount,
    config.RECENT_TOKEN_BUDGET
  ).map((message) => String(message.content))
  const combined = [...previous, String(latestPrompt || '')].filter(Boolean)
  return combined.slice(-desired)
}

function trimQueryWords(value, maxWords) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const words = text.split(' ').filter(Boolean)
  if (words.length <= maxWords) return text
  return words.slice(0, Math.max(1, maxWords)).join(' ')
}

function limitWords(value, maxWords) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const words = text.split(' ').filter(Boolean)
  if (!Number.isFinite(maxWords) || maxWords <= 0) return text
  return words.slice(0, maxWords).join(' ')
}

function stripTrailingThink(value, seed) {
  const text = String(value || '').trim()
  if (!text) return ''
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ''
  const last = words[words.length - 1].toLowerCase()
  if (last !== 'think' && last !== 'thinking') return text
  const promptNorm = normalizeForCompare(seed)
  if (promptNorm.includes(last)) return text
  words.pop()
  return words.join(' ').trim()
}

function fallbackSearchQuery(prompt) {
  const cleaned = String(prompt || '').replace(/\s+/g, ' ').trim()
  return trimQueryWords(trimToCharBudget(cleaned, 200), QUERY_MAX_WORDS)
}

function injectTopicIntoMessages(messages, topic) {
  if (!topic || !Array.isArray(messages) || messages.length === 0) return messages
  const output = messages.slice()
  const topicLine = { role: 'system', content: `Current chat topic: ${topic}` }
  let insertAt = 1
  if (output.length > 1 && output[1].role === 'system') {
    insertAt = 2
  }
  output.splice(insertAt, 0, topicLine)
  return output
}

function injectNonInfoHint(messages, infoSeeking) {
  if (infoSeeking || !Array.isArray(messages) || messages.length === 0) {
    return messages
  }
  const output = messages.slice(0, -1)
  const last = messages[messages.length - 1]
  output.push({
    role: 'system',
    content:
      'The user prompt is conversational/emotional and not information-seeking. ' +
      'Respond naturally and empathetically. Do not provide list-style or search-style answers. ' +
      'Do not mention web search unless asked.',
  })
  if (last) output.push(last)
  return output
}

function injectSourcesIntoMessages(messages, sources, userPrompt, infoSeekingOverride) {
  if (!Array.isArray(messages) || messages.length === 0) return messages
  if (!Array.isArray(sources) || sources.length === 0) return messages

  const context = buildSourcesContext(sources)
  if (!context) return messages
  const explicitSearch = isExplicitSearchRequest(userPrompt)
  const infoSeeking =
    typeof infoSeekingOverride === 'boolean'
      ? infoSeekingOverride
      : isInformationSeekingPromptHeuristic(userPrompt)

  if (!explicitSearch && !infoSeeking) {
    const output = messages.slice(0, -1)
    const last = messages[messages.length - 1]
    output.push({
      role: 'system',
      content:
        'The user prompt is not information-seeking. Respond naturally and empathetically. ' +
        'Do not mention web sources unless the user asked for them.',
    })
    if (last) output.push(last)
    return output
  }

  const output = messages.slice(0, -1)
  const last = messages[messages.length - 1]
  const modeHint = explicitSearch
    ? 'User explicitly requested web search results. Provide a concise summary of the sources.'
    : 'User did not explicitly ask for search results. Provide your own answer and use sources only to improve factual accuracy.'
  const relevanceHint =
    'If the sources do not help answer a factual question, say you do not know.'
  const emotionalHint =
    'If the user prompt is emotional or not information-seeking, respond empathetically and you may ignore the sources.'
  const citationHint =
    'When you use sources, cite them with plain URLs in parentheses.'
  output.push({
    role: 'system',
    content:
      `${modeHint}\n${relevanceHint}\n${emotionalHint}\n${citationHint}\n\nWeb sources summary:\n${context}`,
  })
  if (last) output.push(last)
  return output
}

function buildSourcesContext(sources) {
  return sources
    .filter((source) => source && source.url)
    .map((source, index) => {
      const title = source.title || 'Untitled'
      const summary = source.summary ? `Summary: ${source.summary}` : ''
      const parts = [
        `[${index + 1}] ${title}`,
        `URL: ${source.url}`,
        summary,
      ].filter(Boolean)
      return parts.join('\n')
    })
    .join('\n\n')
}

function isExplicitSearchRequest(value) {
  const text = String(value || '').toLowerCase()
  if (!text.trim()) return false
  const phrases = [
    'search online',
    'search online about',
    'search the web',
    'web search',
    'search about',
    'search for',
    'help me search',
    'find online',
    'find the url of',
    'find the url',
    'find url',
    'get the url',
    'share the url',
    'source url',
    'look it up',
    'look up',
    'browse the web',
    'browse web',
    'google',
    'bing',
    'brave search',
    'list sources',
    'show sources',
    'give me sources',
    'give sources',
  ]
  return phrases.some((phrase) => text.includes(phrase))
}

function isInformationSeekingPromptHeuristic(value) {
  const text = String(value || '').toLowerCase().trim()
  if (!text) return false
  if (isConversationalPrompt(text)) return false
  const explicit = isExplicitSearchRequest(text)
  const hasQuestion = text.includes('?')
  const triggers = [
    'what',
    'why',
    'how',
    'when',
    'where',
    'who',
    'which',
    'explain',
    'define',
    'definition',
    'meaning',
    'guide',
    'steps',
    'tutorial',
    'help me',
    'show me',
    'tell me',
    'find',
    'search',
    'lookup',
    'look up',
    'compare',
    'recommend',
    'best',
    'top',
    'list',
    'latest',
    'current',
    'price',
    'cost',
    'schedule',
    'release',
    'deadline',
    'policy',
    'law',
    'regulation',
    'version',
    'api',
    'docs',
    'weather',
    'forecast',
    'temperature',
    'rain',
    'snow',
    'wind',
    'air quality',
  ]
  const hasTrigger = triggers.some((phrase) => text.includes(phrase))
  if (explicit || hasQuestion || hasTrigger) return true

  const emotionalPhrases = [
    'i like',
    'i love',
    'i hate',
    'i dislike',
    'i feel',
    "i'm",
    'im ',
    'i am',
    'i enjoy',
    'i prefer',
    'my favorite',
    'i dont like',
    "i don't like",
    'i am sad',
    'i am happy',
    'i am upset',
    'i am worried',
    'i am excited',
    'i feel sad',
    'i feel happy',
    'i feel upset',
    'i feel worried',
  ]
  if (emotionalPhrases.some((phrase) => text.includes(phrase))) return false
  if (text.startsWith('i ') || text.startsWith("i'm") || text.startsWith('im ')) {
    return false
  }

  return false
}

async function determineInfoSeeking({ prompt, modelId }) {
  const seed = trimToCharBudget(String(prompt || '').replace(/\s+/g, ' ').trim(), 400)
  const fallbackInfo = isInformationSeekingPromptHeuristic(prompt)
  const fallback = {
    infoSeeking: fallbackInfo,
    needsWeb: fallbackInfo,
    confidence: 0.5,
    reason: 'heuristic',
    source: 'heuristic',
  }
  if (!seed) return { ...fallback, infoSeeking: false, needsWeb: false }
  const classifierModelId = isNonEmptyString(config.INFO_SEEKING_MODEL_ID)
    ? config.INFO_SEEKING_MODEL_ID
    : modelId || config.DEFAULT_MODEL_ID
  const systemPrompt =
    'You are a routing classifier. Decide if the user prompt is information-seeking. ' +
    'Set needs_web=true if the question is time-sensitive, requires verification, or you are unsure. ' +
    'Return only JSON with keys: info_seeking (boolean), needs_web (boolean), ' +
    'confidence (0-1), reason (string).'
  const userPrompt = `Prompt: ${seed}`
  try {
    const response = await callOllamaChat({
      baseUrl: config.OLLAMA_URL,
      model: classifierModelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      timeoutMs: INFO_SEEKING_TIMEOUT_MS,
      options: { temperature: 0, top_p: 0.1 },
      format: 'json',
    })
    const parsed = extractJson(response)
    if (parsed && typeof parsed === 'object') {
      const infoSeeking =
        typeof parsed.info_seeking === 'boolean'
          ? parsed.info_seeking
          : typeof parsed.needs_web === 'boolean'
            ? parsed.needs_web
            : fallback.infoSeeking
      const needsWeb =
        typeof parsed.needs_web === 'boolean' ? parsed.needs_web : infoSeeking
      const confidenceRaw =
        typeof parsed.confidence === 'number' ? parsed.confidence : fallback.confidence
      const confidence = Math.min(1, Math.max(0, confidenceRaw))
      const reason =
        typeof parsed.reason === 'string' && parsed.reason.trim()
          ? parsed.reason.trim()
          : 'classifier'
      return {
        infoSeeking,
        needsWeb,
        confidence,
        reason,
        source: 'llm',
      }
    }
  } catch (error) {
    console.warn('Info-seeking classification failed:', error)
  }

  return fallback
}

function isConversationalPrompt(text) {
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[^\w\s?']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!normalized) return false
  const phrases = [
    'how about you',
    'what about you',
    'and you',
    'how are you',
    'who are you',
    'what are you',
    'what can you do',
    'what do you do',
    'tell me more',
    'tell me more about you',
    'tell me about yourself',
    'introduce yourself',
    'who made you',
    'who built you',
    'who created you',
    'who trained you',
    'are you real',
    'are you human',
    'your name',
    'are you there',
    'you there',
    'can you hear me',
    'can you see me',
    'are you listening',
    'thanks',
    'thank you',
    'thx',
    'ty',
    'hi',
    'hello',
    'hey',
    'sup',
    'yo',
    'good morning',
    'good evening',
    'good night',
    'good afternoon',
    'nice to meet you',
    'bye',
    'goodbye',
    'see you',
    'see ya',
    'later',
    'gn',
  ]
  if (
    phrases.some(
      (phrase) =>
        normalized === phrase ||
        normalized.startsWith(`${phrase} `) ||
        normalized.endsWith(` ${phrase}`) ||
        normalized.includes(` ${phrase} `)
    )
  ) {
    return true
  }
  const shortReplies = [
    'ok',
    'okay',
    'sure',
    'cool',
    'great',
    'nice',
    'fine',
    'alright',
    'thanks',
    'thank you',
    'np',
    'k',
  ]
  if (normalized.length <= 12 && shortReplies.includes(normalized)) return true
  return false
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

function startSseResponse(res) {
  if (res.headersSent) return
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  })
}

function writeSse(res, event, payload) {
  if (res.writableEnded) return
  res.write(`event: ${event}\n`)
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function addChatListener(chatKey, res) {
  const entry = { res, heartbeat: null }
  let listeners = chatListeners.get(chatKey)
  if (!listeners) {
    listeners = new Set()
    chatListeners.set(chatKey, listeners)
  }
  listeners.add(entry)
  entry.heartbeat = setInterval(() => {
    if (res.writableEnded) return
    res.write(': ping\n\n')
  }, 15000)
  return entry
}

function removeChatListener(chatKey, entry) {
  if (!entry) return
  if (entry.heartbeat) {
    clearInterval(entry.heartbeat)
  }
  const listeners = chatListeners.get(chatKey)
  if (!listeners) return
  listeners.delete(entry)
  if (listeners.size === 0) {
    chatListeners.delete(chatKey)
  }
}

function broadcastChatUpdate(chatKey, payload) {
  const listeners = chatListeners.get(chatKey)
  if (!listeners || listeners.size === 0) return
  for (const entry of listeners) {
    if (entry && entry.res && !entry.res.writableEnded) {
      writeSse(entry.res, 'chatinfoupdate', payload)
    }
  }
}

async function streamOllamaChat({ res, baseUrl, model, messages, end = true }) {
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

  if (end && !res.writableEnded) {
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
  modelId,
  sources = [],
  deferHeavy = false,
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
    polished: false,
  })

  record.last_message_ts = messageTs
  record.last_updated_ts = messageTs

  record.idempotency = record.idempotency || {}
  record.idempotency[messageId] = {
    answer,
    ts: answerTs,
    sources: Array.isArray(sources) ? sources : [],
    polished: false,
  }

  store.saveChat(record)

  if (deferHeavy) {
    return
  }

  await runPostAnswerUpdates({
    record,
    answer,
    answerTs,
    messageTs,
    prompt,
    modelId,
    sources,
    messageId,
  })
  store.saveChat(record)
}

async function runPostAnswerUpdates({
  record,
  answer,
  answerTs,
  messageTs,
  prompt,
  modelId,
  sources = [],
  messageId,
  infoSeeking = true,
  routeConfidence = 1,
  emit,
  skipMemory = false,
}) {
  if (!record) return
  try {
    await updateTopicAndTitle({
      record,
      prompt,
      messageTs: messageTs || answerTs,
      modelId,
      emit,
    })
    await maybePolishAnswer({
      record,
      answer,
      prompt,
      modelId,
      infoSeeking,
      routeConfidence,
      sources,
      messageId,
    })
    if (!skipMemory) {
      await maybeUpdateMemory(record, answerTs, modelId, POST_ANSWER_TASK_TIMEOUT_MS)
      store.saveChat(record)
    }
    store.saveChat(record)
  } catch (error) {
    console.error('Post-answer updates failed:', error)
  }
}

async function maybePolishAnswer({
  record,
  answer,
  prompt,
  modelId,
  infoSeeking,
  routeConfidence,
  sources,
  messageId,
}) {
  if (!record || !answer) return false
  const trimmedAnswer = String(answer || '').trim()
  if (!trimmedAnswer) return false

  const shouldPolish = trimmedAnswer.length >= POLISH_MIN_CHARS

  if (!shouldPolish) {
    console.log('[polish] skipped', {
      chatId: record.chat_id,
      infoSeeking,
      sources: Array.isArray(sources) ? sources.length : 0,
      answerChars: trimmedAnswer.length,
      confidence: routeConfidence,
      minChars: POLISH_MIN_CHARS,
    })
    return false
  }
  console.log('[polish] start', {
    chatId: record.chat_id,
    infoSeeking,
    sources: Array.isArray(sources) ? sources.length : 0,
    answerChars: trimmedAnswer.length,
    confidence: routeConfidence,
    minChars: POLISH_MIN_CHARS,
  })

  const polishModelId = isNonEmptyString(config.POLISH_MODEL_ID)
    ? config.POLISH_MODEL_ID
    : modelId || config.DEFAULT_MODEL_ID

  const systemPrompt =
    'You are a response polisher. Improve clarity and structure. ' +
    'Do not add new facts. If unsure, say you are not sure. ' +
    'Keep it concise and preserve any citations already present.'
  const userPrompt = [
    'User prompt:',
    trimToCharBudget(String(prompt || '').replace(/\s+/g, ' ').trim(), 400),
    '',
    'Original answer:',
    trimToCharBudget(trimmedAnswer, 1200),
  ].join('\n')

  let polished = ''
  try {
    polished = await runHighLlm(() =>
      callOllamaChat({
        baseUrl: config.OLLAMA_URL,
        model: polishModelId,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        stream: false,
        timeoutMs: POLISH_TIMEOUT_MS,
        options: { temperature: 0.2 },
      })
    )
  } catch (error) {
    console.warn('Polish pass failed:', error)
    return false
  }

  const cleaned = String(polished || '').trim()
  if (!cleaned) {
    console.warn('[polish] empty response')
    return false
  }
  if (normalizeForCompare(cleaned) === normalizeForCompare(trimmedAnswer)) {
    console.log('[polish] no change')
    return false
  }

  if (Array.isArray(record.raw_messages)) {
    for (let i = record.raw_messages.length - 1; i >= 0; i -= 1) {
      const message = record.raw_messages[i]
      if (message && message.role === 'assistant') {
        message.content = cleaned
        message.polished = true
        break
      }
    }
  }

  if (messageId && record.idempotency && record.idempotency[messageId]) {
    record.idempotency[messageId].answer = cleaned
    record.idempotency[messageId].polished = true
  }

  record.last_updated_ts = Date.now()
  store.saveChat(record)

  const chatKey = `${record.user_id}:${record.chat_id}`
  broadcastChatUpdate(chatKey, {
    type: 'answer',
    user_id: record.user_id,
    chat_id: record.chat_id,
    content: { answer: cleaned, ts: record.last_updated_ts, polished: true },
  })

  console.log('[polish] applied', {
    chatId: record.chat_id,
    answerChars: cleaned.length,
  })

  return true
}

async function updateTopicAndTitle({ record, prompt, messageTs, modelId, emit }) {
  if (!record) return
  const safeModelId = modelId || config.DEFAULT_MODEL_ID
  const titleModelId = isNonEmptyString(config.TITLE_MODEL_ID)
    ? config.TITLE_MODEL_ID
    : safeModelId
  const topicModelId = isNonEmptyString(config.TOPIC_MODEL_ID)
    ? config.TOPIC_MODEL_ID
    : safeModelId
  if (!record.title) {
    const firstPrompt = getFirstUserPrompt(record, prompt)
    if (firstPrompt) {
      let generated = ''
      try {
        generated = await runHighLlm(() =>
          generateTitle(firstPrompt, titleModelId, TITLE_TIMEOUT_MS)
        )
      } catch (error) {
        console.error('Title generation failed:', error)
      }
      if (!generated) {
        const fallback = fallbackTitleFromPrompt(firstPrompt)
        if (fallback) {
          record.title = fallback
        }
      } else {
        record.title = generated
      }
    }
  }

  if (record.title) {
    store.saveChat(record)
    if (emit) {
      emit({
        stage: 'title',
        title: record.title,
        done: false,
      })
    }
    const chatKey = `${record.user_id}:${record.chat_id}`
    broadcastChatUpdate(chatKey, {
      type: 'title',
      user_id: record.user_id,
      chat_id: record.chat_id,
      content: { title: record.title },
    })
  }

  await updateTopicAfterAnswer({
    record,
    prompt,
    messageTs,
    modelId: topicModelId,
  })
  store.saveChat(record)
  if (emit && record.topic) {
    emit({
      stage: 'topic',
      topic: record.topic,
      ts: record.last_topic_ts,
      done: false,
    })
  }
  const topicKey = `${record.user_id}:${record.chat_id}`
  if (record.topic) {
    broadcastChatUpdate(topicKey, {
      type: 'topic',
      user_id: record.user_id,
      chat_id: record.chat_id,
      content: { topic: record.topic, ts: record.last_topic_ts || 0 },
    })
  }
}

async function maybeUpdateMemory(record, now, modelId, timeoutMs) {
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
      const updated = await runHighLlm(() =>
        updateMemory({
          baseUrl: config.OLLAMA_URL,
          memoryModelId: modelId || config.DEFAULT_MODEL_ID,
          previousSummary: record.summary,
          previousFacts: record.facts,
          messagesSince,
          summaryBudget: config.SUMMARY_TOKEN_BUDGET,
          factsBudget: config.FACTS_TOKEN_BUDGET,
          inputTokenBudget: config.MEMORY_UPDATE_INPUT_TOKENS,
          timeoutMs,
        })
      )

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

async function generateTitle(prompt, modelId, timeoutMs) {
  console.log('[title] request', {
    modelId: modelId || config.DEFAULT_MODEL_ID,
    timeoutMs,
    promptPreview: summarizePrompt(prompt, 120),
  })
  const systemPrompt =
    'Return a JSON object with a "title" string only. ' +
    'Do not copy the prompt verbatim. ' +
    'No analysis. No extra keys.'
  const seed = summarizePrompt(prompt, 240)
  const userPrompt = buildTitlePrompt(seed, false)

  const titleModelId = modelId || config.DEFAULT_MODEL_ID

  const response = await callOllamaChat({
    baseUrl: config.OLLAMA_URL,
    model: titleModelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    timeoutMs,
    options: TITLE_LLM_OPTIONS,
    format: 'json',
  })

  const parsed = extractJson(response)
  const rawTitle =
    parsed && typeof parsed.title === 'string'
      ? parsed.title
      : String(response || '').split('\n')[0]
  const cleaned = stripTrailingThink(
    limitWords(
      String(rawTitle || '')
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .replace(/[.?!]+$/, '')
        .trim(),
      TITLE_MAX_WORDS
    ),
    seed
  )

  if (!cleaned || isTooSimilarTitle(cleaned, seed)) {
    console.warn('[title] empty or similar response, retrying with relaxed options')
    const retry = await callOllamaChat({
      baseUrl: config.OLLAMA_URL,
      model: titleModelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildTitlePrompt(seed, true) },
      ],
      stream: false,
      timeoutMs,
      options: TITLE_LLM_RETRY_OPTIONS,
      format: 'json',
    })
    const retryParsed = extractJson(retry)
    const retryRaw =
      retryParsed && typeof retryParsed.title === 'string'
        ? retryParsed.title
        : String(retry || '').split('\n')[0]
    const retryCleaned = stripTrailingThink(
      limitWords(
        String(retryRaw || '')
          .replace(/^["'“”]+|["'“”]+$/g, '')
          .replace(/[.?!]+$/, '')
          .trim(),
        TITLE_MAX_WORDS
      ),
      seed
    )
    if (!retryCleaned) return fallbackTitleFromPrompt(prompt)
    return trimToCharBudget(retryCleaned, config.TITLE_MAX_CHARS)
  }
  return trimToCharBudget(cleaned, config.TITLE_MAX_CHARS)
}

function summarizePrompt(value, maxChars) {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim()
  return trimToCharBudget(cleaned, maxChars || 120)
}

function buildTitlePrompt(seed, strict) {
  const extra = strict
    ? 'Use different wording than the prompt.'
    : 'Paraphrase briefly.'
  return [
    `Title (max ${TITLE_MAX_WORDS} words). Return JSON: {"title":"..."}.`,
    extra,
    `Latest prompt: ${seed}`,
  ]
    .filter(Boolean)
    .join('\n')
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isTooSimilarTitle(title, prompt) {
  const a = normalizeForCompare(title)
  const b = normalizeForCompare(prompt)
  if (!a || !b) return false
  if (a === b) return true
  if (b.includes(a) && a.length >= 8) return true
  return false
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

  const record = store.getOrCreateChat(userId, chatId)

  const title = record.title || 'New chat'

  const lastMessageTs = getLastMessageTs(record)

  if (parts.length === 1) {
    respondJson(res, 200, {
      user_id: record.user_id,
      chat_id: record.chat_id,
      title,
      topic: record.topic || '',
      summary: record.summary || '',
      facts: Array.isArray(record.facts) ? record.facts : [],
      last_updated_ts: getLastUpdatedTs(record),
      last_message_ts: lastMessageTs,
      last_summary_ts: getLastSummaryTs(record),
      last_topic_ts: Number.isFinite(record.last_topic_ts) ? record.last_topic_ts : 0,
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

async function handleChatStream(req, res, url) {
  const userId = url.searchParams.get('user_id')
  if (!isNonEmptyString(userId)) {
    respondJson(res, 400, { error: 'Missing user_id.' })
    return
  }

  const path = url.pathname.replace(/^\/api\/chats\//, '')
  const parts = path.split('/').filter(Boolean)
  const chatId = decodeURIComponent(parts[0] || '')
  const action = parts[1]

  if (!isNonEmptyString(chatId) || action !== 'stream') {
    respondJson(res, 404, { error: 'Not found.' })
    return
  }

  const record = store.getOrCreateChat(userId, chatId)

  startSseResponse(res)
  writeSse(res, 'ready', { ok: true, user_id: userId, chat_id: chatId })

  const chatKey = `${userId}:${chatId}`
  const entry = addChatListener(chatKey, res)

  const currentTitle = record.title || ''
  const currentTopic = record.topic || ''
  if (currentTitle) {
    writeSse(res, 'chatinfoupdate', {
      type: 'title',
      user_id: userId,
      chat_id: chatId,
      content: { title: currentTitle },
    })
  }
  if (currentTopic) {
    writeSse(res, 'chatinfoupdate', {
      type: 'topic',
      user_id: userId,
      chat_id: chatId,
      content: { topic: currentTopic, ts: record.last_topic_ts || 0 },
    })
  }

  const cleanup = () => removeChatListener(chatKey, entry)
  req.on('close', cleanup)
  res.on('close', cleanup)
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
