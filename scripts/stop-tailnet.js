const { spawnSync } = require('node:child_process')

function run(cmd, stdio = 'inherit') {
  return spawnSync(cmd, {
    shell: true,
    stdio,
  })
}

function tryRun(cmd) {
  const result = run(cmd)
  return result.status === 0
}

function ensureOperator() {
  const user = process.env.USER || process.env.USERNAME
  if (!user) return false
  if (run(`tailscale set --operator=${user}`, 'pipe').status === 0) {
    return true
  }
  tryRun('sudo -v')
  return tryRun(`sudo tailscale set --operator=${user}`)
}

ensureOperator()

// Try without sudo first, then prompt with sudo if needed.
const stopped = tryRun('tailscale serve --https=3000 localhost:3000 off')
tryRun('tailscale serve --http=3000 localhost:3000 off')
if (!stopped) {
  tryRun('sudo -v')
  tryRun('sudo tailscale serve --https=3000 localhost:3000 off')
  tryRun('sudo tailscale serve --http=3000 localhost:3000 off')
}

const statusOk = tryRun('tailscale serve status')
if (!statusOk) {
  tryRun('sudo -v')
  tryRun('sudo tailscale serve status')
}

// Ignore failures if processes are not running.
tryRun('pkill -f "node server.js"')
tryRun('pkill -f "node src/agent/server.js"')

process.exit(0)
