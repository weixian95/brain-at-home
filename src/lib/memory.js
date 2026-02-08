const {
  estimateTokens,
  trimToTokenBudget,
  trimFactsToBudget,
  extractJson,
} = require('./utils')
const { callOllamaChat } = require('./ollama')

function buildMemoryBlock(summary, facts, budgets) {
  const trimmedSummary = trimToTokenBudget(summary || '', budgets.summary)
  const trimmedFacts = trimFactsToBudget(facts || [], budgets.facts)
  const parts = []

  if (trimmedSummary) {
    parts.push(`Summary:\n${trimmedSummary}`)
  }

  if (trimmedFacts.length) {
    parts.push(`Facts:\n- ${trimmedFacts.join('\n- ')}`)
  }

  return parts.join('\n\n')
}

function applyTokenBudget(messages, budgetTokens) {
  if (!budgetTokens || budgetTokens <= 0) return []
  const selected = []
  let used = 0

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    const tokens = estimateTokens(message.content)
    if (used + tokens > budgetTokens) {
      if (selected.length === 0) {
        const available = Math.max(1, budgetTokens - used)
        const trimmed = trimToTokenBudget(message.content, available)
        selected.push({ ...message, content: trimmed })
        used += estimateTokens(trimmed)
      }
      break
    }
    selected.push(message)
    used += tokens
  }

  return selected.reverse()
}

function selectRecentUserMessages(rawMessages, recentUserCount, recentTokenBudget) {
  if (!Array.isArray(rawMessages) || recentUserCount <= 0) return []
  const userMessages = rawMessages.filter(
    (message) => message && message.role === 'user' && message.content
  )
  const slice = userMessages.slice(-recentUserCount)
  return applyTokenBudget(slice, recentTokenBudget)
}

function buildPromptMessages({
  systemPrompt,
  summary,
  facts,
  rawMessages,
  newPrompt,
  budgets,
  recentTurns,
}) {
  const messages = [{ role: 'system', content: systemPrompt }]
  const memoryBlock = buildMemoryBlock(summary, facts, budgets)
  if (memoryBlock) {
    messages.push({ role: 'system', content: memoryBlock })
  }

  const recentUserCount = Math.max(0, (recentTurns || 0) - 1)
  const recent = selectRecentUserMessages(
    rawMessages,
    recentUserCount,
    budgets.recent
  )
  for (const message of recent) {
    messages.push({ role: message.role, content: message.content })
  }

  messages.push({ role: 'user', content: newPrompt })
  return messages
}

function shouldUpdateMemory({ turnsSinceSummary, tokensSinceSummary, config }) {
  if (turnsSinceSummary >= config.SUMMARY_EVERY_N_TURNS) return true
  if (tokensSinceSummary >= config.SUMMARY_TOKEN_THRESHOLD) return true
  return false
}

function formatMessagesForMemory(messages) {
  return messages
    .map((message) => {
      const role = message.role === 'assistant' ? 'Assistant' : 'User'
      return `${role}: ${message.content}`
    })
    .join('\n')
}

async function updateMemory({
  baseUrl,
  memoryModelId,
  previousSummary,
  previousFacts,
  messagesSince,
  summaryBudget,
  factsBudget,
  inputTokenBudget,
  timeoutMs,
}) {
  const prunedMessages = applyTokenBudget(messagesSince, inputTokenBudget)

  const systemPrompt =
    'You are a memory curator for a chat assistant. ' +
    'Update the summary and facts based on the new messages. ' +
    'Return JSON only with keys "summary" and "facts".'

  const userPrompt = [
    `Summary token budget (approx): ${summaryBudget}`,
    `Facts token budget (approx): ${factsBudget}`,
    'Rules:',
    '- Summary should be concise and stable.',
    '- Facts must be a JSON array of short strings (no markdown).',
    '- Only keep durable user-specific info, goals, or decisions.',
    '',
    'Previous summary:',
    previousSummary || '(empty)',
    '',
    'Previous facts:',
    JSON.stringify(previousFacts || []),
    '',
    'New messages (chronological):',
    formatMessagesForMemory(prunedMessages) || '(none)',
  ].join('\n')

  const response = await callOllamaChat({
    baseUrl,
    model: memoryModelId,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    stream: false,
    timeoutMs,
  })

  const parsed = extractJson(response)
  if (!parsed || typeof parsed.summary !== 'string' || !Array.isArray(parsed.facts)) {
    return null
  }

  const summary = trimToTokenBudget(parsed.summary, summaryBudget)
  const facts = trimFactsToBudget(parsed.facts, factsBudget)

  return { summary, facts }
}

module.exports = {
  buildPromptMessages,
  selectRecentUserMessages,
  shouldUpdateMemory,
  updateMemory,
}
