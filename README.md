# Brain At Home
Expose a self-hosted Ollama chat endpoint to clients on the same private Tailscale network, with lightweight
memory, optional web search, and streaming status updates.

## Features
- Local Ollama API gateway with chat memory + latest 3 user prompts.
- Tailnet access via Tailscale.
- Optional web agent (Brave Search + local Ollama).
- NDJSON streaming with stage events.
- Title/topic generation for chat UI updates.

## Tailscale setup
1. Install Tailscale and log in.
2. On the host running BrainAtHome, enable serve:
   - `npm run start:tailnet`
3. From another device on the same tailnet, call the API:
   - `https://<your-host>.tailnet.ts.net:3000/api/chat`

## Start server
- `npm run start` (API)
- `npm run start:tailnet` (API + Tailscale proxy)
- `npm run start:agent` (web agent)
- `npm run start:tailnet:agent` (API + agent + Tailscale)

Health check: `curl http://127.0.0.1:3000/health`

## Stop server
```
npm run stop:tailnet
```

## How BrainAtHome thinks (flow)
This section explains the decision flow and which models are used for internal tasks. The design goal is
good responsiveness on a single 16GB VRAM GPU.

### Performance goals
- Keep the main response path on one model to avoid heavy model‑switch latency.
- Allow model switching only for low‑priority tasks (title/topic/classifier), where small models are acceptable.
- Keep memory updates and metadata generation off the critical path.

### Model roles (and why)
- **Main response:** `model_id` (client-selected). Highest quality, minimal switching.
- **Info‑seeking classifier:** `INFO_SEEKING_MODEL_ID` (defaults to `model_id` if unset). A small model keeps routing fast without delaying the answer.
- **Title & topic:** `TITLE_MODEL_ID` / `TOPIC_MODEL_ID` (defaults to `model_id`). Title is generated once per chat; topic updates as the conversation evolves.
- **Brave query generation:** uses `model_id` by default so the query reflects the same intent and context as the answer.
- **Memory updates:** uses `model_id` by default so summaries stay consistent with the assistant’s tone and knowledge.

### Non‑web mode (`use_web=false`)
1. Build the prompt from:
   - stored memory summary/facts
   - latest 3 user prompts (latest is primary)
2. Send to the client-selected model (`model_id`).
3. Stream the answer back to the client.
4. After the answer, run background tasks:
   - generate/update title
   - generate/update topic
   - update memory summary/facts (if thresholds are met)

### Web mode (`use_web=true`)
1. Classify if the prompt is information‑seeking (LLM classifier).
   - If classified as non‑info, the flow falls back to local (web‑off) response.
2. Build a Brave-friendly query using:
   - latest prompt (always)
   - prior 2 prompts only if the latest lacks context
3. Web agent fetches up to 5 Brave results.
4. The front-desk model (`model_id`) answers using:
   - memory summary/facts
   - latest 3 prompts
   - web sources
5. Run the same background tasks as non-web mode.

## API
- `GET /health`
- `POST /api/chat` (required: `user_id`, `chat_id`, `prompt`, `message_id`; optional `model_id`, `stream`, `use_web`)
- `GET /api/tags` or `/api/models`
- `GET /api/chats?user_id=...`
- `GET /api/chats/:chat_id?user_id=...`
- `GET /api/chats/:chat_id/messages?user_id=...&offset=0&limit=50`
- `DELETE /api/chats/:chat_id?user_id=...`

Example request:
```json
{
  "user_id": "user-123",
  "chat_id": "chat-001",
  "model_id": "llama3",
  "prompt": "What did I ask you last time?",
  "message_id": "9f7ad4c7-09e9-4e28-9e49-2c5c53f2d4e2",
  "client_ts": 1730775930123,
  "stream": false,
  "use_web": true
}
```

Response includes `sources` when the web agent is used:
```json
{
  "chat_id": "chat-001",
  "answer": "Answer with citations...",
  "sources": [
    { "title": "Example", "url": "https://example.com", "summary": "Short summary..." }
  ]
}
```
