const { config } = require('../lib/config')

function extractAnswer(payload) {
  if (!payload || typeof payload !== 'object') return ''
  if (typeof payload.answer === 'string') return payload.answer
  if (payload.message && typeof payload.message.content === 'string') {
    return payload.message.content
  }
  if (
    Array.isArray(payload.choices) &&
    payload.choices[0] &&
    payload.choices[0].message &&
    typeof payload.choices[0].message.content === 'string'
  ) {
    return payload.choices[0].message.content
  }
  if (typeof payload.output === 'string') return payload.output
  if (typeof payload.result === 'string') return payload.result
  if (typeof payload.text === 'string') return payload.text
  return ''
}

function extractSources(payload) {
  if (!payload || typeof payload !== 'object') return []
  if (Array.isArray(payload.sources)) {
    return payload.sources
      .filter((source) => source && source.url)
      .map((source) => ({
        title: source.title || 'Untitled',
        url: source.url,
      }))
  }
  return []
}

async function callWebAgent({
  messages,
  prompt,
  userId,
  chatId,
  messageId,
  clientTs,
  modelId,
  timeoutMs,
}) {
  if (!config.WEB_AGENT_URL) {
    throw new Error('WEB_AGENT_URL is not configured.')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs || config.WEB_AGENT_TIMEOUT_MS)

  try {
    const response = await fetch(config.WEB_AGENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        prompt,
        user_id: userId,
        chat_id: chatId,
        message_id: messageId,
        client_ts: clientTs,
        model_id: modelId,
        stream: false,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Web agent error ${response.status}: ${text}`)
    }

    const payload = await response.json()
    const answer = extractAnswer(payload)
    const sources = extractSources(payload)
    if (!answer) {
      throw new Error('Web agent returned an empty response.')
    }

    return { answer, sources }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Web agent request timed out.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function streamWebAgent({
  messages,
  prompt,
  userId,
  chatId,
  messageId,
  clientTs,
  modelId,
  timeoutMs,
  onEvent,
}) {
  if (!config.WEB_AGENT_URL) {
    throw new Error('WEB_AGENT_URL is not configured.')
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs || config.WEB_AGENT_TIMEOUT_MS)
  let aborted = false

  try {
    const response = await fetch(config.WEB_AGENT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        prompt,
        user_id: userId,
        chat_id: chatId,
        message_id: messageId,
        client_ts: clientTs,
        model_id: modelId,
        stream: true,
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Web agent error ${response.status}: ${text}`)
    }

    if (!response.body) {
      throw new Error('Web agent streaming body missing.')
    }

    const reader = response.body.getReader()
    let buffer = ''
    let answer = ''
    let sources = []
    let sawSources = false
    let sawDone = false

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value).toString('utf-8')
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed && parsed.stage === 'final_answer' && typeof parsed.content === 'string') {
            answer = parsed.content
          }
          if (parsed && Array.isArray(parsed.sources)) {
            sources = parsed.sources
              .filter((source) => source && source.url)
              .map((source) => ({
                title: source.title || 'Untitled',
                url: source.url,
              }))
            sawSources = true
          }
          if (parsed && parsed.stage === 'sources') {
            sawSources = true
          }
          if (parsed && parsed.done === true) {
            sawDone = true
          }
          if (typeof onEvent === 'function') {
            onEvent(parsed)
          }
        } catch {
          // ignore
        }
      }
    }

    const trailing = buffer.trim()
    if (trailing) {
      try {
        const parsed = JSON.parse(trailing)
        if (parsed && parsed.stage === 'final_answer' && typeof parsed.content === 'string') {
          answer = parsed.content
        }
        if (parsed && Array.isArray(parsed.sources)) {
          sources = parsed.sources
            .filter((source) => source && source.url)
            .map((source) => ({
              title: source.title || 'Untitled',
              url: source.url,
            }))
          sawSources = true
        }
        if (parsed && parsed.stage === 'sources') {
          sawSources = true
        }
        if (parsed && parsed.done === true) {
          sawDone = true
        }
        if (typeof onEvent === 'function') {
          onEvent(parsed)
        }
      } catch {
        // ignore
      }
    }

    return {
      answer,
      sources,
      sawSources,
      completed: !aborted && (sawDone || answer.length > 0),
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      aborted = true
      throw new Error('Web agent request timed out.')
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = { callWebAgent, streamWebAgent }
