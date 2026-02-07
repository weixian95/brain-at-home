const queues = new Map()

async function withChatLock(key, fn) {
  const previous = queues.get(key) || Promise.resolve()
  let release
  const current = new Promise((resolve) => {
    release = resolve
  })

  queues.set(key, previous.then(() => current))

  await previous
  try {
    return await fn()
  } finally {
    release()
    if (queues.get(key) === current) {
      queues.delete(key)
    }
  }
}

module.exports = { withChatLock }
