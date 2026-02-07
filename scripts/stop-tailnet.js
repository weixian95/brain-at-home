const { spawnSync } = require('node:child_process')

function run(cmd) {
  return spawnSync(cmd, {
    shell: true,
    stdio: 'inherit',
  })
}

function tryRun(cmd) {
  const result = run(cmd)
  return result.status === 0
}

// Try without sudo first, then prompt with sudo if needed.
const stopped = tryRun('tailscale serve --http=3000 localhost:3000 off')
if (!stopped) {
  tryRun('sudo -v')
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
