const fs = require('node:fs')
const path = require('node:path')
const dotenv = require('dotenv')

const rootDir = path.join(__dirname, '..', '..')

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return
  dotenv.config({ path: filePath, override: false })
}

loadEnvFile(path.join(rootDir, '.env.local'))
loadEnvFile(path.join(rootDir, '.env'))

