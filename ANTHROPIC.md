# Anthropic Support in ModelRelay

## Architecture

```
┌────────────────────────┐   Anthropic Messages API   ┌──────────────────────────────────┐
│  Claude Code CLI       │ ───── POST /v1/messages ──►│  ModelRelay Server              │
│  VS Code Extension     │ ◀──── SSE / JSON ─────────  │  Port 7352 / 7777               │
│  Hermes Agent          │                             │                                  │
│  curl / any client     │                             │  lib/anthropic-routes.js         │
└────────────────────────┘                             │    ┌────────────────────────┐   │
                                                       │    │  anthropic-adapter.js  │   │
┌────────────────────────┐                             │    │                        │   │
│  Provider (DeepSeek,   │   OpenAI Chat Completions   │    │  anthropicToOpenAI()   │   │
│  Gemini, Ollama, etc)  │ ◀──── POST /v1/chat/comps── │    │    • model mapping     │   │
│                        │ ──── SSE / JSON ──────────► │    │    • tool_choice conv   │   │
│  auto-fastest router   │                             │    │    • tool_result conv   │   │
└────────────────────────┘                             │    │    • thinking blocks    │   │
                                                       │    │                        │   │
                                                       │    │  openaiToAnthropic()   │   │
                                                       │    │    • finish_reason map  │   │
                                                       │    │    • tool_calls conv    │   │
                                                       │    │    • reasoning_content  │   │
                                                       │    │                        │   │
                                                       │    │  StreamTransformer      │   │
                                                       │    │    • SSE event align    │   │
                                                       │    │    • content_block seq  │   │
                                                       │    └────────────────────────┘   │
                                                       └──────────────────────────────────┘
```

**Request flow:**

```
 Client                         ModelRelay                        Provider
   │                               │                                │
   │  POST /v1/messages            │                                │
   │  (Anthropic format)           │                                │
   ├──────────────────────────────►│                                │
   │                               │                                │
   │                               │  anthropicToOpenAI()           │
   │                               │  ──► convert to OpenAI format  │
   │                               │                                │
   │                               │  POST /v1/chat/completions     │
   │                               │  (OpenAI format)               │
   │                               ├───────────────────────────────►│
   │                               │                                │
   │                               │  ◄── response (JSON / SSE) ───│
   │                               │                                │
   │                               │  openaiToAnthropic()           │
   │                               │  ──► convert to Anthropic fmt  │
   │                               │  (or StreamTransformer for SSE)│
   │                               │                                │
   │  ◄── response (JSON / SSE) ───│                                │
   │  (Anthropic format)           │                                │
```

## Overview

ModelRelay now supports the Anthropic Messages API (`/v1/messages`) via an internal adapter. This allows Claude Code CLI and the VS Code extension to connect through ModelRelay while using Anthropic's API format, without exposing Anthropic as a separate provider in the ModelRelay UI.

**Key properties:**

- Anthropic models are **hidden** from `sources.js` and do not appear in the ModelRelay web UI’s provider/model lists.
- The adapter translates Anthropic requests to OpenAI-compatible format and forwards them to the existing OpenAI provider infrastructure (including API key management, routing, retries, and scoring).
- No external loopback port is required; the forwarding happens in-process via HTTP to the same server instance.
- Supports both streaming and non-streaming responses, tool calls, and reasoning content.

## File Structure

- `lib/anthropic-adapter.js` – Pure conversion functions between Anthropic and OpenAI formats.
- `lib/anthropic-routes.js` – Express routes for Anthropic endpoints; registers on the app before OpenAI routes.
- `lib/server.js` – Modified to import and invoke `setupAnthropicRoutes(app, port)` before defining OpenAI routes.
- `sources.js` – No changes required; Anthropic provider is omitted intentionally.

## Configuration

### Model Mapping

Anthropic model names are mapped to OpenAI-compatible model IDs via `MODEL_MAP` inside `anthropic-adapter.js`:

```js
const DEFAULT_MODEL_MAP = {
  'claude-sonnet-4-5': 'auto-fastest',
  'claude-haiku-4-5':  'auto-fastest',
  'claude-opus-4-5':   'auto-fastest',
}
```

To override mappings, set the environment variable `ANTHROPIC_MODEL_MAP`:

```bash
export ANTHROPIC_MODEL_MAP="claude-sonnet-4-5=gpt-4o,claude-haiku-4-5=gpt-4o-mini"
```

This is useful if you want to send Anthropic requests to a specific OpenAI provider rather than the auto-fastest router.

### Health Check

The Claude CLI performs a `HEAD /` request to verify server connectivity. The adapter registers a handler that responds with `200 OK`.

## Testing

### Unit Tests

Run the adapter unit tests:

```bash
pnpm test
```

Or directly:

```bash
node --test test/anthropic-adapter.test.js
```

### Integration Tests

Integration tests exercise the live `/v1/messages` endpoint:

```bash
node --test test/messages-integration.test.js
```

The integration test starts the server on a random port, registers a mock OpenAI-compatible endpoint, and verifies both streaming and non-streaming behavior.

### Live Smoke Tests

A standalone bash script tests the adapter against a **running server** (basic message, SSE streaming, and multi-turn tool calls):

```bash
./test/live-test.sh                    # http://localhost:7352
BASE_URL=http://localhost:7777 ./test/live-test.sh
API_KEY=sk-xxx ./test/live-test.sh
```

The script retries automatically if the model doesn't call a tool (common with `tool_choice: "auto"`).

## Troubleshooting

- **Anthropic models do not appear in the UI:** This is by design. The UI only reads `sources.js`, which no longer contains Anthropic.
- **Connection refused errors:** Ensure the server is running and that `setupAnthropicRoutes` is called before routes are registered. The `port` passed to `runServer` must be the actual listening port.
- **Authentication errors:** The `x-api-key` header sent by Claude Code must match a valid ModelRelay API key. The adapter forwards this header unchanged to the OpenAI provider logic.
- **Streaming issues:** Check server logs for errors in the Anthropic streaming transformer. The transformer aligns OpenAI SSE chunks to Anthropic’s event sequence.

## Advanced

### Adding Custom Anthropic Models

To support additional Anthropic model IDs (e.g., future releases), add them to `DEFAULT_MODEL_MAP` in `anthropic-adapter.js` and optionally configure `ANTHROPIC_MODEL_MAP` to map them to suitable OpenAI models.

### Direct Provider Integration

If you prefer the adapter to bypass the OpenAI provider system entirely (e.g., to call Anthropic’s API directly), modify `anthropic-routes.js` to perform a direct `fetch` to `https://api.anthropic.com`. You would then need to manage API keys and retries yourself. The current implementation reuses ModelRelay’s provider management.
