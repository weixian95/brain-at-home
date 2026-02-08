const highQueue = []
let running = false

function enqueue(task, priority) {
  return new Promise((resolve, reject) => {
    const entry = { task, resolve, reject }
    highQueue.push(entry)
    schedule()
  })
}

function schedule() {
  if (running) return
  const next = highQueue.shift()
  if (!next) return
  running = true
  Promise.resolve()
    .then(next.task)
    .then((result) => next.resolve(result))
    .catch((error) => next.reject(error))
    .finally(() => {
      running = false
      schedule()
    })
}

function runHighLlm(task) {
  return enqueue(task, 'high')
}

module.exports = { runHighLlm }
