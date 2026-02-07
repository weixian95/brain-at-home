const { URL } = require('node:url')

async function callOllamaChat({ baseUrl, model, messages, stream = false }) {
  const endpoint = new URL('/api/chat', baseUrl)
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Ollama error ${response.status}: ${text}`)
  }

  const payload = await response.json()
  if (!payload || !payload.message || typeof payload.message.content !== 'string') {
    throw new Error('Unexpected Ollama response.')
  }

  return payload.message.content
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
