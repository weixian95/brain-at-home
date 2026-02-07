require('../lib/env')

const http = require('node:http')
const { URL } = require('node:url')

const { config } = require('../lib/config')
const { readJsonBody, respondJson, setCors, trimToCharBudget } = require('../lib/utils')

const MAX_QUERY_CHARS = 512

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

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
        model: config.WEB_AGENT_MODEL_ID || config.DEFAULT_MODEL_ID,
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

  const prompt = getPrompt(payload)
  if (!isNonEmptyString(prompt)) {
    respondJson(res, 400, { error: 'Missing prompt.' })
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
    emitEvent({ stage: 'digest_prompt', content: digestPrompt(prompt), done: false })

    const query = String(prompt).slice(0, MAX_QUERY_CHARS)
    const freshness = pickFreshness(prompt)
    emitEvent({ stage: 'search_started', query, freshness, done: false })

    const results = await braveSearch({
      query,
      count: config.WEB_AGENT_MAX_RESULTS,
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

    emitEvent({ stage: 'fetch_started', count: results.length, done: false })
    const sources = await readSources(results)
    const withContent = sources.filter((source) => source.content).length
    emitEvent({
      stage: 'fetch_complete',
      count: sources.length,
      with_content: withContent,
      done: false,
    })

    const sourceList = buildSourceList(sources)

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

function getPrompt(payload) {
  if (isNonEmptyString(payload.prompt)) return payload.prompt
  if (Array.isArray(payload.messages)) {
    const lastUser = [...payload.messages]
      .reverse()
      .find((message) => message && message.role === 'user' && message.content)
    if (lastUser && lastUser.content) return String(lastUser.content)
  }
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

async function readSources(results) {
  const maxChars = config.WEB_AGENT_MAX_CHARS_EACH
  const timeoutMs = config.WEB_AGENT_FETCH_TIMEOUT_MS
  const dynamicEnabled = config.WEB_AGENT_DYNAMIC_FETCH
  const dynamicDomains = parseDomainList(config.WEB_AGENT_DYNAMIC_DOMAINS)
  const dynamicTimeoutMs = config.WEB_AGENT_DYNAMIC_TIMEOUT_MS
  const dynamicWaitMs = config.WEB_AGENT_DYNAMIC_WAIT_MS
  const concurrency = Math.max(1, Math.min(8, config.WEB_AGENT_FETCH_CONCURRENCY || 3))

  const playwright = dynamicEnabled ? getPlaywright() : null
  let browser = null
  if (playwright) {
    try {
      browser = await playwright.chromium.launch({ headless: true })
    } catch {
      browser = null
    }
  }

  let mapped
  try {
    mapped = await mapWithConcurrency(results, concurrency, async (item) => {
      let content = ''
      try {
        const useDynamic = browser && shouldUseDynamicFetch(item.url, dynamicDomains)
        if (useDynamic) {
          content = await fetchPageTextDynamic(
            item.url,
            maxChars,
            dynamicTimeoutMs,
            dynamicWaitMs,
            browser
          )
        }
        if (!content) {
          content = await fetchPageText(item.url, maxChars, timeoutMs)
        }
      } catch {
        content = ''
      }

      const snippet = [item.description, item.extra].filter(Boolean).join(' ')

      return {
        title: item.title,
        url: item.url,
        snippet: trimToCharBudget(snippet, 600),
        content: trimToCharBudget(content, maxChars),
      }
    })
  } finally {
    if (browser) {
      await browser.close()
    }
  }

  return mapped
}

async function fetchPageText(url, maxChars, timeoutMs) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8',
        'User-Agent': 'BrainAtHome-Agent/0.1',
      },
      redirect: 'follow',
      signal: controller.signal,
    })

    if (!response.ok) {
      return ''
    }

    const contentType = response.headers.get('content-type') || ''
    const raw = await response.text()

    let text = raw
    if (contentType.includes('text/html')) {
      text = stripHtml(raw)
    }

    text = normalizeWhitespace(text)
    return trimToCharBudget(text, maxChars)
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchPageTextDynamic(url, maxChars, timeoutMs, waitMs, browser) {
  if (!browser) return ''
  const page = await browser.newPage()
  try {
    page.setDefaultTimeout(timeoutMs)
    await page.goto(url, { waitUntil: 'networkidle', timeout: timeoutMs })
    if (waitMs > 0) {
      await page.waitForTimeout(waitMs)
    }
    const text = await page.evaluate(() => {
      if (document && document.body) return document.body.innerText || ''
      return ''
    })
    return trimToCharBudget(normalizeWhitespace(text), maxChars)
  } finally {
    await page.close()
  }
}

function stripHtml(html) {
  if (!html) return ''
  const withoutScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const withoutTags = withoutScripts.replace(/<[^>]+>/g, ' ')
  return decodeHtmlEntities(withoutTags)
}

function decodeHtmlEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16)
      if (!Number.isFinite(code)) return match
      return String.fromCodePoint(code)
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10)
      if (!Number.isFinite(code)) return match
      return String.fromCodePoint(code)
    }
    if (Object.prototype.hasOwnProperty.call(ENTITY_MAP, entity)) {
      return ENTITY_MAP[entity]
    }
    return match
  })
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

function parseDomainList(value) {
  if (!value) return []
  return String(value)
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

function shouldUseDynamicFetch(urlValue, domains) {
  if (!Array.isArray(domains) || domains.length === 0) return true
  const host = getHostname(urlValue).toLowerCase()
  if (!host) return false
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

function getPlaywright() {
  try {
    // Lazy-load to keep dynamic fetch optional.
    return require('playwright')
  } catch {
    return null
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length)
  let index = 0

  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (index < items.length) {
      const current = index
      index += 1
      results[current] = await mapper(items[current], current)
    }
  })

  await Promise.all(workers)
  return results
}

function buildSourceList(sources) {
  return sources
    .filter((source) => source && source.url)
    .map((source) => ({
      title: source.title || 'Untitled',
      url: source.url,
      summary: summarizeSource(source),
    }))
}

function summarizeSource(source) {
  if (!source) return ''
  const snippet = String(source.snippet || '').trim()
  if (snippet) return trimToCharBudget(snippet, 360)
  const content = String(source.content || '').trim()
  if (content) return trimToCharBudget(content, 360)
  return ''
}
