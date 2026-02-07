const fs = require('node:fs')

function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function trimToTokenBudget(text, budgetTokens) {
  if (!text) return ''
  const maxChars = budgetTokens * 4
  if (text.length <= maxChars) return text
  const trimmed = text.slice(0, Math.max(0, maxChars - 3))
  return `${trimmed}...`
}

function trimToCharBudget(text, maxChars) {
  if (!text) return ''
  if (text.length <= maxChars) return text
  const trimmed = text.slice(0, Math.max(0, maxChars - 3))
  return `${trimmed}...`
}

function trimFactsToBudget(facts, budgetTokens) {
  if (!Array.isArray(facts) || facts.length === 0) return []
  const kept = []
  let used = 0
  for (const fact of facts) {
    const tokens = estimateTokens(String(fact))
    if (used + tokens > budgetTokens) break
    kept.push(String(fact))
    used += tokens
  }
  return kept
}

function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('Request body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })

    req.on('end', () => {
      try {
        const raw = chunks.length ? Buffer.concat(chunks).toString('utf-8') : ''
        const parsed = raw ? JSON.parse(raw) : null
        resolve(parsed)
      } catch (error) {
        reject(error)
      }
    })

    req.on('error', reject)
  })
}

function respondJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Cache-Control', 'no-store, max-age=0')
  res.setHeader('Pragma', 'no-cache')
  res.setHeader('Expires', '0')
  res.end(JSON.stringify(payload))
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,x-api-key')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  res.setHeader('Access-Control-Max-Age', '600')
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true })
}

function safeId(value) {
  return Buffer.from(String(value)).toString('base64url')
}

function extractJson(text) {
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  const candidate = text.slice(start, end + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

module.exports = {
  estimateTokens,
  trimToTokenBudget,
  trimToCharBudget,
  trimFactsToBudget,
  readJsonBody,
  respondJson,
  setCors,
  ensureDir,
  safeId,
  extractJson,
}
