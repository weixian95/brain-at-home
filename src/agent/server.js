require('../lib/env')

const http = require('node:http')
const { URL } = require('node:url')

const { config } = require('../lib/config')
const { readJsonBody, respondJson, setCors, trimToCharBudget } = require('../lib/utils')

const MAX_QUERY_CHARS = 512

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
        time: new Date().toISOString(),
        brave_configured: Boolean(config.BRAVE_API_KEY),
      })
      return
    }

    if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/agent')) {
      await handleAgent(req, res)
      return
    }

    respondJson(res, 404, { error: 'Not found.' })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.'
    respondJson(res, 500, { error: message })
  }
})

server.listen(config.WEB_AGENT_PORT, config.WEB_AGENT_BIND_HOST, () => {
  console.log(
    `Web agent listening on http://${config.WEB_AGENT_BIND_HOST}:${config.WEB_AGENT_PORT}`
  )
  if (!config.BRAVE_API_KEY) {
    console.log('Brave Search: disabled (BRAVE_API_KEY not set)')
  }
})

async function handleAgent(req, res) {
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

  const query = getQuery(payload)
  if (!isNonEmptyString(query)) {
    respondJson(res, 400, { error: 'Missing query.' })
    return
  }

  if (!config.BRAVE_API_KEY) {
    respondJson(res, 503, { error: 'BRAVE_API_KEY is not configured.' })
    return
  }

  const useStream = isStreamRequested(payload.stream)
  if (useStream) {
    startStreamResponse(res)
  }

  const emitEvent = (event) => {
    if (!useStream) return
    writeNdjson(res, event)
  }

  try {
    const trimmedQuery = trimToCharBudget(query, MAX_QUERY_CHARS)
    emitEvent({ stage: 'digest_prompt', content: digestPrompt(trimmedQuery), done: false })

    const freshness = pickFreshness(trimmedQuery)
    emitEvent({ stage: 'search_started', query: trimmedQuery, freshness, done: false })

    const maxResults = Math.min(5, Math.max(1, config.WEB_AGENT_MAX_RESULTS || 5))
    const results = await braveSearch({
      query: trimmedQuery,
      count: maxResults,
      freshness,
    })

    emitEvent({
      stage: 'search_summary',
      items: summarizeResults(results),
      done: false,
    })

    if (!results.length) {
      if (useStream) {
        emitEvent({ stage: 'sources', sources: [], done: false })
        res.end()
        return
      }
      respondJson(res, 200, { sources: [] })
      return
    }

    const sourceList = buildSourceListFromResults(results, maxResults)

    if (useStream) {
      emitEvent({ stage: 'sources', sources: sourceList, done: false })
      res.end()
      return
    }

    respondJson(res, 200, { sources: sourceList })
  } catch (error) {
    if (useStream) {
      emitEvent({
        stage: 'error',
        error: error instanceof Error ? error.message : 'Web agent error.',
        done: true,
      })
      res.end()
      return
    }
    const message = error instanceof Error ? error.message : 'Web agent error.'
    respondJson(res, 502, { error: message })
  }
}

function getQuery(payload) {
  if (isNonEmptyString(payload.query)) return payload.query
  if (isNonEmptyString(payload.prompt)) return payload.prompt
  return ''
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isStreamRequested(value) {
  return value === true || value === 'true' || value === 1 || value === '1'
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

function digestPrompt(prompt) {
  const cleaned = String(prompt || '').replace(/\s+/g, ' ').trim()
  if (!cleaned) return ''
  if (cleaned.length <= 180) return cleaned
  return `${cleaned.slice(0, 177)}...`
}

function summarizeResults(results) {
  return results.slice(0, 5).map((item) => ({
    title: item.title || 'Untitled',
    source: getHostname(item.url),
  }))
}

function getHostname(urlValue) {
  try {
    const url = new URL(urlValue)
    return url.hostname
  } catch {
    return ''
  }
}

function pickFreshness(text) {
  const lowered = String(text || '').toLowerCase()
  if (
    lowered.includes('today') ||
    lowered.includes('right now') ||
    lowered.includes('breaking') ||
    lowered.includes('just announced')
  ) {
    return 'pd'
  }
  if (
    lowered.includes('this week') ||
    lowered.includes('recent') ||
    lowered.includes('latest') ||
    lowered.includes('news') ||
    lowered.includes("what's new") ||
    lowered.includes('what is new') ||
    lowered.includes('current')
  ) {
    return 'pw'
  }
  if (lowered.includes('this month')) return 'pm'
  if (lowered.includes('this year') || /\b202[5-9]\b/.test(lowered)) return 'py'
  return ''
}

async function braveSearch({ query, count, freshness }) {
  const endpoint = config.BRAVE_API_ENDPOINT
  const url = new URL(endpoint)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.max(1, Math.min(20, count || 5))))
  url.searchParams.set('safesearch', 'moderate')
  url.searchParams.set('extra_snippets', 'true')
  if (freshness) {
    url.searchParams.set('freshness', freshness)
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': config.BRAVE_API_KEY,
      'User-Agent': 'BrainAtHome-Agent/0.1',
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Brave Search error ${response.status}: ${text}`)
  }

  const payload = await response.json()
  const results = payload && payload.web && Array.isArray(payload.web.results)
    ? payload.web.results
    : []

  return results
    .map((item) => ({
      title: item.title || '',
      url: item.url || '',
      description: item.description || '',
      extra: Array.isArray(item.extra_snippets) ? item.extra_snippets.join(' ') : '',
    }))
    .filter((item) => isHttpUrl(item.url))
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function buildSourceListFromResults(results, maxResults) {
  return (Array.isArray(results) ? results : [])
    .filter((item) => item && item.url)
    .slice(0, maxResults || 5)
    .map((item) => ({
      title: item.title || 'Untitled',
      url: item.url,
      summary: trimToCharBudget(
        [item.description, item.extra].filter(Boolean).join(' '),
        360
      ),
    }))
}
