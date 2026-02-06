const path = require('node:path')

const config = {
  PORT: Number.parseInt(process.env.PORT || '3000', 10),
  BIND_HOST: process.env.BIND_HOST || '127.0.0.1',
  OLLAMA_URL: process.env.OLLAMA_URL || 'http://127.0.0.1:11434',
  SYSTEM_PROMPT:
    process.env.SYSTEM_PROMPT ||
    'You are a helpful assistant. Use the provided memory to stay consistent and accurate.',
  DEFAULT_MODEL_ID: process.env.DEFAULT_MODEL_ID || 'llama3',
  MEMORY_MODEL_ID: process.env.MEMORY_MODEL_ID || 'qwen2.5:14b',
  TITLE_MODEL_ID: process.env.TITLE_MODEL_ID || '',
  TITLE_MAX_CHARS: Number.parseInt(process.env.TITLE_MAX_CHARS || '60', 10),
  RECENT_TURNS: Number.parseInt(process.env.RECENT_TURNS || '6', 10),
  SUMMARY_EVERY_N_TURNS: Number.parseInt(
    process.env.SUMMARY_EVERY_N_TURNS || '6',
    10
  ),
  SUMMARY_TOKEN_BUDGET: Number.parseInt(
    process.env.SUMMARY_TOKEN_BUDGET || '400',
    10
  ),
  FACTS_TOKEN_BUDGET: Number.parseInt(process.env.FACTS_TOKEN_BUDGET || '200', 10),
  RECENT_TOKEN_BUDGET: Number.parseInt(
    process.env.RECENT_TOKEN_BUDGET || '800',
    10
  ),
  MEMORY_UPDATE_INPUT_TOKENS: Number.parseInt(
    process.env.MEMORY_UPDATE_INPUT_TOKENS || '1200',
    10
  ),
  SUMMARY_TOKEN_THRESHOLD: Number.parseInt(
    process.env.SUMMARY_TOKEN_THRESHOLD || '1200',
    10
  ),
  MAX_BODY_BYTES: Number.parseInt(process.env.MAX_BODY_BYTES || '2097152', 10),
  DATA_DIR: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
}

config.CHATS_DIR = process.env.CHATS_DIR || path.join(config.DATA_DIR, 'chats')

module.exports = { config }
