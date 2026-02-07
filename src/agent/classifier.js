const TRIGGER_PHRASES = [
  'latest',
  'recent',
  'today',
  'yesterday',
  'tomorrow',
  'this week',
  'this month',
  'this year',
  'next week',
  'next month',
  'next year',
  'current',
  'right now',
  'breaking',
  'news',
  'event',
  'events',
  'what changed',
  'what is happening now',
  "what's happening now",
  'happening now',
  "what's new",
  'what is new',
  'update',
  'updates',
  'just announced',
  'release date',
  'pricing',
  'price',
  'cost',
  'schedule',
  'calendar',
  'standings',
  'score',
  'scores',
  'stock',
  'market',
  'exchange rate',
  'weather',
  'forecast',
  'policy',
  'policies',
  'regulation',
  'regulations',
  'law',
  'laws',
  'election',
  'poll',
  'polls',
  'source',
  'sources',
  'citation',
  'citations',
  'reference',
  'references',
  'verify',
  'verification',
  'link',
  'links',
]

const OPT_OUT_PHRASES = [
  'no web search',
  'do not search',
  "don't search",
  'without searching',
  'no browsing',
  'do not browse',
  "don't browse",
  'no internet',
  'do not use the internet',
  "don't use the internet",
  'no web',
  'no online',
]

const TRIGGER_REGEXES = [
  /\bwho\s+is\s+the\s+current\b/i,
  /\bwho\s+is\s+the\s+incumbent\b/i,
  /\bcurrent\s+(president|prime minister|pm|ceo|cfo|cto|governor|mayor|minister|speaker|chair|director)\b/i,
  /\b(202[5-9]|203\d)\b/, // years likely to be out of date for a static model
]

const NEGATION_PATTERNS = [
  /\bno\s+news\b/i,
  /\bnot\s+news\b/i,
  /\bno\s+recent\b/i,
  /\bnot\s+recent\b/i,
  /\bno\s+latest\b/i,
  /\bnot\s+latest\b/i,
  /\bno\s+update\b/i,
  /\bno\s+updates\b/i,
  /\bnot\s+updated\b/i,
  /\bnot\s+current\b/i,
  /\bno\s+current\b/i,
]

function hasOptOut(text) {
  return OPT_OUT_PHRASES.some((phrase) => text.includes(phrase))
}

function isNegated(text, phrase) {
  if (!phrase) return false
  if (NEGATION_PATTERNS.some((regex) => regex.test(text))) return true

  const window = 12
  let index = text.indexOf(phrase)
  while (index !== -1) {
    const start = Math.max(0, index - window)
    const prefix = text.slice(start, index)
    if (/\b(no|not|without|avoid|never)\b/.test(prefix)) {
      return true
    }
    index = text.indexOf(phrase, index + phrase.length)
  }
  return false
}

function shouldUseWebAgent(prompt) {
  const text = String(prompt || '').toLowerCase()
  if (!text.trim()) return { use: false, reasons: [] }
  if (hasOptOut(text)) return { use: false, reasons: ['opt_out'] }

  const reasons = []
  for (const phrase of TRIGGER_PHRASES) {
    if (text.includes(phrase)) {
      if (!isNegated(text, phrase)) {
        reasons.push(phrase)
      }
    }
  }

  for (const regex of TRIGGER_REGEXES) {
    if (regex.test(prompt)) {
      reasons.push(regex.source)
    }
  }

  return { use: reasons.length > 0, reasons }
}

module.exports = { shouldUseWebAgent }
