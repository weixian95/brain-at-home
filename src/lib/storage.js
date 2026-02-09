const fs = require('node:fs')
const path = require('node:path')
const { ensureDir, safeId } = require('./utils')

class FileStore {
  constructor(baseDir, chatsDir) {
    this.baseDir = baseDir
    this.chatsDir = chatsDir
    ensureDir(this.baseDir)
    ensureDir(this.chatsDir)
  }

  chatPath(userId, chatId) {
    const userDir = path.join(this.chatsDir, safeId(userId))
    const fileName = `${safeId(chatId)}.json`
    return { userDir, filePath: path.join(userDir, fileName) }
  }

  loadChat(userId, chatId) {
    const { filePath } = this.chatPath(userId, chatId)
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(raw)
  }

  deleteChat(userId, chatId) {
    const { filePath } = this.chatPath(userId, chatId)
    if (!fs.existsSync(filePath)) return false
    fs.unlinkSync(filePath)
    return true
  }

  saveChat(record) {
    const { userDir, filePath } = this.chatPath(record.user_id, record.chat_id)
    ensureDir(userDir)
    const tmpPath = `${filePath}.tmp`
    const data = JSON.stringify(record, null, 2)
    fs.writeFileSync(tmpPath, data)
    fs.renameSync(tmpPath, filePath)
  }

  getOrCreateChat(userId, chatId) {
    return this.getOrCreateChatWithMeta(userId, chatId).record
  }

  getOrCreateChatWithMeta(userId, chatId) {
    const existing = this.loadChat(userId, chatId)
    if (existing) return { record: existing, created: false }
    const record = {
      user_id: userId,
      chat_id: chatId,
      title: '',
      topic: '',
      summary: '',
      facts: [],
      last_updated_ts: 0,
      last_message_ts: 0,
      last_summary_ts: 0,
      last_topic_ts: 0,
      raw_messages: [],
      idempotency: {},
    }
    this.saveChat(record)
    return { record, created: true }
  }

  listChatsForUser(userId) {
    const userDir = path.join(this.chatsDir, safeId(userId))
    if (!fs.existsSync(userDir)) return []
    const entries = fs.readdirSync(userDir)
    const chats = []

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue
      const filePath = path.join(userDir, entry)
      try {
        const raw = fs.readFileSync(filePath, 'utf-8')
        const record = JSON.parse(raw)
        const lastMessageTs = getLastMessageTs(record)
        const lastUpdatedTs = getLastUpdatedTs(record)
        chats.push({
          user_id: record.user_id,
          chat_id: record.chat_id,
          title: record.title || '',
          topic: record.topic || '',
          summary: record.summary || '',
          facts: Array.isArray(record.facts) ? record.facts : [],
          last_updated_ts: lastUpdatedTs,
          last_message_ts: lastMessageTs,
          last_summary_ts: Number.isFinite(record.last_summary_ts)
            ? record.last_summary_ts
            : 0,
          last_topic_ts: Number.isFinite(record.last_topic_ts)
            ? record.last_topic_ts
            : 0,
          raw_count: Array.isArray(record.raw_messages)
            ? record.raw_messages.length
            : 0,
        })
      } catch {
        // Ignore unreadable records.
      }
    }

    return chats.sort((a, b) => b.last_message_ts - a.last_message_ts)
  }
}

function getLastMessageTs(record) {
  if (!record) return 0
  if (Number.isFinite(record.last_message_ts) && record.last_message_ts > 0) {
    return record.last_message_ts
  }
  if (!Array.isArray(record.raw_messages)) return 0
  return record.raw_messages.reduce((max, message) => {
    const ts = Number.isFinite(message.ts) ? message.ts : 0
    return ts > max ? ts : max
  }, 0)
}

function getLastUpdatedTs(record) {
  if (!record) return 0
  if (Number.isFinite(record.last_updated_ts) && record.last_updated_ts > 0) {
    return record.last_updated_ts
  }
  return getLastMessageTs(record)
}

module.exports = { FileStore }
