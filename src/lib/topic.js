const { callOllamaChat } = require('./ollama')
const { extractJson, trimToCharBudget } = require('./utils')

const TOPIC_LLM_OPTIONS = { temperature: 0.2, repeat_penalty: 1.2 }
const TOPIC_LLM_RETRY_OPTIONS = { temperature: 0.7, repeat_penalty: 1.2 }

function sanitizeTopic(value, maxWords) {
  if (!value) return ''
  const cleaned = String(value)
    .replace(/\s+/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .replace(/^["'“”]+|["'“”]+$/g, '')
  if (!cleaned) return ''
  const words = cleaned.split(' ').filter(Boolean)
  const limited = words.slice(0, Math.max(1, maxWords || 5)).join(' ')
  return trimToCharBudget(limited.replace(/[.?!]+$/, '').trim(), 80)
}

function buildTopicPrompt({ recentPrompts, maxWords, strict }) {
  const prompts = Array.isArray(recentPrompts) && recentPrompts.length
    ? recentPrompts
    : []

  const recentLines = prompts.length
    ? prompts
        .map((item, index) => {
          const line = trimToCharBudget(String(item || ''), 200)
          return `${index + 1}) ${line}`
        })
        .join('\n')
    : '(none)'
  const strictLine = strict
    ? 'Use different wording than the prompt.'
    : 'Paraphrase briefly.'
  return [
    `Topic (max ${maxWords} words). Return JSON: {"topic":"..."}.`,
    strictLine,
    'Recent messages (oldest to newest):',
    recentLines,
  ]
    .filter(Boolean)
    .join('\n')
}

async function generateTopic({
  baseUrl,
  modelId,
  currentTopic,
  recentPrompts,
  maxWords,
  timeoutMs,
  options,
}) {
  if (!modelId) return { topic: currentTopic || '', changed: false }
  console.log('[topic] generate', {
    modelId,
    timeoutMs,
    maxWords,
    currentTopic,
    recentPrompts: summarizePrompts(recentPrompts, 120),
  })
  const systemPrompt =
    'Return a JSON object with a "topic" string only. ' +
    'Do not copy the prompt verbatim. ' +
    'Output at least one word. No analysis.'

  const userPrompt = buildTopicPrompt({ recentPrompts, maxWords, strict: false })

  const response = await callOllamaChat({
    baseUrl,
    model: modelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    timeoutMs,
    options: options || TOPIC_LLM_OPTIONS,
    format: 'json',
  })

  const parsed = extractJson(response)
  const rawTopic =
    (parsed && typeof parsed.topic === 'string'
      ? parsed.topic
      : typeof response === 'string'
        ? response.split('\n')[0]
        : '')
  const topic = sanitizeTopic(rawTopic, maxWords)
  const latestPrompt = Array.isArray(recentPrompts) && recentPrompts.length
    ? String(recentPrompts[recentPrompts.length - 1] || '')
    : ''
  if (!topic || isTooSimilarTopic(topic, latestPrompt)) {
    console.warn('[topic] empty response, retrying with relaxed options')
    const retryResponse = await callOllamaChat({
      baseUrl,
      model: modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: buildTopicPrompt({ recentPrompts, maxWords, strict: true }) },
      ],
      stream: false,
      timeoutMs,
      options: TOPIC_LLM_RETRY_OPTIONS,
      format: 'json',
    })
    const retryParsed = extractJson(retryResponse)
    const retryRaw =
      (retryParsed && typeof retryParsed.topic === 'string'
        ? retryParsed.topic
        : typeof retryResponse === 'string'
          ? retryResponse.split('\n')[0]
          : '')
    const retryTopic = sanitizeTopic(retryRaw, maxWords)
    if (!retryTopic) {
      return { topic: currentTopic || '', changed: false }
    }
    return { topic: retryTopic, changed: true }
  }

  return { topic, changed: true }
}

function summarizePrompts(prompts, maxChars) {
  if (!Array.isArray(prompts) || prompts.length === 0) return []
  return prompts.map((item) =>
    trimToCharBudget(String(item || '').replace(/\s+/g, ' ').trim(), maxChars)
  )
}

function normalizeForCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function isTooSimilarTopic(topic, prompt) {
  const a = normalizeForCompare(topic)
  const b = normalizeForCompare(prompt)
  if (!a || !b) return false
  if (a === b) return true
  if (b.includes(a) && a.length >= 8) return true
  return false
}

module.exports = { generateTopic }
