const { URL } = require('node:url')

async function callOllamaChat({
  baseUrl,
  model,
  messages,
  stream = false,
  timeoutMs = null,
  options = null,
  allowThinking = false,
  format = null,
}) {
  const endpoint = new URL('/api/chat', baseUrl)
  const controller = new AbortController()
  const timeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null
  let response

  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream,
        ...(options ? { options } : {}),
        ...(format ? { format } : {}),
      }),
      signal: controller.signal,
    })
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw new Error('Ollama request timed out.')
    }
    throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Ollama error ${response.status}: ${text}`)
  }

  const payload = await response.json()
  if (!payload || !payload.message || typeof payload.message.content !== 'string') {
    throw new Error('Unexpected Ollama response.')
  }

  let content = payload.message.content
  if (!content.trim() && allowThinking) {
    const thinking =
      typeof payload.message.thinking === 'string'
        ? payload.message.thinking
        : typeof payload.message.reasoning === 'string'
          ? payload.message.reasoning
          : ''
    if (thinking.trim()) {
      console.warn('[ollama] empty content; using thinking/reasoning fallback', {
        model,
      })
      content = thinking
    }
  }

  if (!content.trim()) {
    const message = payload && payload.message ? payload.message : null
    console.warn('[ollama] empty response', {
      model,
      stream,
      options: options || null,
      keys: payload ? Object.keys(payload) : [],
      messageKeys: message ? Object.keys(message) : [],
      reasoningLen:
        message && typeof message.reasoning === 'string'
          ? message.reasoning.length
          : 0,
      thinkingLen:
        message && typeof message.thinking === 'string'
          ? message.thinking.length
          : 0,
      toolCalls: Array.isArray(message && message.tool_calls)
        ? message.tool_calls.length
        : 0,
      doneReason: payload && payload.done_reason ? payload.done_reason : null,
    })
  }

  return content
}

async function listOllamaModels({ baseUrl }) {
  const endpoint = new URL('/api/tags', baseUrl)
  const response = await fetch(endpoint, { method: 'GET' })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Ollama error ${response.status}: ${text}`)
  }

  const payload = await response.json()
  if (!payload || !Array.isArray(payload.models)) {
    throw new Error('Unexpected Ollama models response.')
  }

  return payload.models
}

module.exports = { callOllamaChat, listOllamaModels }
