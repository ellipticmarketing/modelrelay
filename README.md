# 🚀 modelrelay

[![npm version](https://img.shields.io/npm/v/modelrelay?color=green&style=flat-square)](https://npmjs.com/package/modelrelay)
[![GitHub stars](https://img.shields.io/github/stars/ellipticmarketing/modelrelay?style=flat-square)](https://github.com/ellipticmarketing/modelrelay/stargazers)
[![Join Discord](https://img.shields.io/badge/Join_Discord-5865F2?style=flat-square&logo=discord)](https://discord.gg/AqX6Sawq5w)

[**Join our Discord**](https://discord.gg/AqX6Sawq5w) for discussions, feature requests, and community support.

<div align="center">
  <img src="docs/assets/dashboard.png" alt="ModelRelay Dashboard" width="100%">
  <br/>
  <p><i>The smartest, fastest, and completely free local router for your AI coding needs.</i></p>
</div>

---

### 🔥 100% Free • Auto-Routing • 80+ Models • 12+ Providers • OpenAI-Compatible

**modelrelay** is an OpenAI-compatible local router that benchmarks free coding models across top providers and automatically forwards your requests to the best available model. 

### ✨ Why use modelrelay?

- 💸 **Completely Free:** Stop paying for API usage. We seamlessly provide access to robust free models.
- 🧠 **State-of-the-Art (SOTA) Models:** Out-of-the-box availability for top-tier models including **Kimi K2.5, Minimax M2.5, GLM 5, Deepseek V3.2**, and more.
- 🏢 **Reliable Providers:** We route requests securely through trusted, high-performance platforms like **NVIDIA, Groq, OpenRouter, OpenCode Zen, Ollama, Kiro, and Google**.
- ⚡ **Lightning Fast:** The built-in benchmark continually evaluates metrics to pick the fastest and most capable LLM for your request.
- 🔄 **OpenAI-Compatible:** A perfect drop-in replacement that works seamlessly with your existing tools, scripts, and workflows.

## 🚀 Install via NPM

```bash
npm install -g modelrelay

# Start it
modelrelay
```

Once started, modelrelay is accessible at `http://localhost:7352/`.

Router endpoint:

- Base URL: `http://127.0.0.1:7352/v1`
- API key: any string
- Model: `auto-fastest` (router picks actual backend)

## 🚀 Install via Docker

### Prerequisites
- Docker Engine
- Docker Compose (the `docker compose` command)


```bash
mkdir modelrelay

cd modelrelay

curl -fsSL -o Dockerfile https://raw.githubusercontent.com/ellipticmarketing/modelrelay/master/Dockerfile
curl -fsSL -o docker-compose.yml https://raw.githubusercontent.com/ellipticmarketing/modelrelay/master/docker-compose.yml

docker compose up -d --build
```

Once running, modelrelay is accessible at `http://localhost:7352/`.

## 🔌 Installing Integrations

Use `modelrelay onboard` to save provider keys and auto-configure integrations for OpenClaw or OpenCode.

```bash
modelrelay onboard
```

If you prefer manual setup, use the examples below.

## OpenCode Integration

`modelrelay onboard` can auto-configure OpenCode.

If you want manual setup, put this in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "router": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "modelrelay",
      "options": {
        "baseURL": "http://127.0.0.1:7352/v1",
        "apiKey": "dummy-key"
      },
      "models": {
        "auto-fastest": {
          "name": "Auto Fastest"
        }
      }
    }
  },
  "model": "router/auto-fastest"
}
```

## OpenClaw Integration

`modelrelay onboard` can auto-configure OpenClaw.

If you want manual setup, merge this into `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "modelrelay": {
        "baseUrl": "http://127.0.0.1:7352/v1",
        "api": "openai-completions",
        "apiKey": "no-key",
        "models": [
          { "id": "auto-fastest", "name": "Auto Fastest" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "modelrelay/auto-fastest"
      },
      "models": {
        "modelrelay/auto-fastest": {}
      }
    }
  }
}
```

## Claude Code / Anthropic Messages API Integration

modelrelay now supports **Anthropic's Messages API format** directly via the same base URL. This means [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code/overview) and the [Claude Code VS Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) can use modelrelay as a drop-in proxy:

```
Base URL:    http://localhost:7352/v1
API Key:     any string (e.g. "anthropic-key")
Models:      claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-5
```

No separate proxy process needed — the Anthropic format conversion is built directly into the modelrelay server.

### How it works

modelrelay receives Anthropic-format requests at `POST /v1/messages`, converts them to OpenAI format, routes through the existing provider selection, then converts responses back to Anthropic format. Streaming emits the full Anthropic SSE event sequence:

```
message_start → content_block_start → content_block_delta → content_block_stop → message_delta → message_stop
```

Tool calls, reasoning content (`thinking_delta`), and plain text content are all supported.

### Claude Code CLI Setup

Set these setting in your $HOME/.claude/settings.json file:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:7352",
    "ANTHROPIC_API_KEY": "sk-whatever",
    "ANTHROPIC_MODEL": "claude-sonnet-4-5",
  }
}
```
Note: even though there is no API key needed. You need to start with `sk-`

### Claude Code VS Code Extension Setup

Add these settings to your VS Code `/path-to/vscode-or-code-server/User/settings.json` or global settings:

```json
{
  "claudeCode.disableLoginPrompt": true,
  "claudeCode.environmentVariables": [
    { "name": "ANTHROPIC_BASE_URL", "value": "http://localhost:7352" },
    { "name": "ANTHROPIC_API_KEY",  "value": "sk-whatever" },
    { "name": "ANTHROPIC_MODEL",   "value": "claude-sonnet-4-5" }
  ]
}
```

> **Note:** The `environmentVariables` setting uses `"name"` not `"key"` for each entry object.

### Available Anthropic Models

| Model ID | Maps To |
|----------|---------|
| `claude-sonnet-4-5` | `auto-fastest` (best overall model) |
| `claude-haiku-4-5`  | `auto-fastest` |
| `claude-opus-4-5`   | `auto-fastest` |

Override the mapping via the `ANTHROPIC_MODEL_MAP` environment variable:

```bash
export ANTHROPIC_MODEL_MAP="claude-sonnet-4-5=kimi-k2.5,claude-haiku-4-5=gemini-3-flash-preview"
```

### Testing the endpoint

```bash
# Non-streaming
curl -X POST http://localhost:7352/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":100,"messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl -N -X POST http://localhost:7352/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: any-key" \
  -H "anthropic-version: 2023-06-01" \
  -d '{"model":"claude-sonnet-4-5","max_tokens":100,"stream":true,"messages":[{"role":"user","content":"Hello"}]}'
```

## CLI

```bash
modelrelay [--port <number>] [--log] [--ban <model1,model2>]
modelrelay onboard [--port <number>]
modelrelay install --autostart
modelrelay start --autostart
modelrelay uninstall --autostart
modelrelay status --autostart
modelrelay update
modelrelay autoupdate [--enable|--disable|--status] [--interval <hours>]
modelrelay autostart [--install|--start|--uninstall|--status]
modelrelay config export
modelrelay config import <token>
```

Request terminal logging is disabled by default. Use `--log` to enable it.

`modelrelay install --autostart` also triggers an immediate start attempt so you do not need a separate command after install.

During `modelrelay onboard`, you will also be prompted to enable auto-start on login.

`modelrelay update` upgrades the global npm package and, when autostart is configured, stops the background service first and starts it again after the update.

Auto-update is enabled by default. While the router is running, modelrelay checks npm periodically (default: every 24 hours) and applies updates automatically.

Use `modelrelay autoupdate --status` to inspect state, `modelrelay autoupdate --disable` to turn it off, and `modelrelay autoupdate --enable --interval 12` to re-enable with a custom interval.

Use `modelrelay config export` to print a transferable config token (base64url-encoded JSON), and `modelrelay config import <token>` to load it on another machine.
You can also import by stdin:

```bash
modelrelay config export | modelrelay config import
```

## Endpoints

### `/v1/chat/completions`

`POST /v1/chat/completions` is an OpenAI-compatible chat completions endpoint.

- Use `model: "auto-fastest"` to route to the best model overall
- Use a grouped model ID such as `minimax-m2.5`, `kimi-k2.5`, or `glm4.7` to route within that model group
- For grouped IDs, modelrelay selects the provider with the best current QoS for that group
- In the Web UI, pinned models can now use either `Canonical Group` mode (default, pins the same model across providers) or `Exact Provider Row` mode from `Settings`
- Streaming and non-streaming requests are both supported

### `/v1/models`

`GET /v1/models` returns the models exposed by the router. The endpoint uses **header-based detection** to serve the correct format:

**OpenAI clients** (no `anthropic-version` header) receive an OpenAI-format model list:
- Model IDs are grouped slugs such as `minimax-m2.5`, `kimi-k2.5`, and `glm4.7`
- Each grouped ID can represent the same model across multiple providers
- When you select one of these IDs in `/v1/chat/completions`, modelrelay routes the request to the provider with the best current QoS for that model group
- `auto-fastest` is also exposed and routes to the best model overall

```json
{
  "object": "list",
  "data": [
    { "id": "auto-fastest", "object": "model", "owned_by": "router" },
    { "id": "minimax-m2.5", "object": "model", "owned_by": "relay" },
    { "id": "kimi-k2.5", "object": "model", "owned_by": "relay" },
    { "id": "glm4.7", "object": "model", "owned_by": "relay" }
  ]
}
```

**Anthropic clients** (with `anthropic-version` header, e.g. `anthropic-version: 2023-06-01`) receive an Anthropic-format model list:

```json
{
  "data": [
    { "type": "model", "id": "claude-sonnet-4-5" },
    { "type": "model", "id": "claude-haiku-4-5" },
    { "type": "model", "id": "claude-opus-4-5" }
  ]
}
```

## Config

- Router config file: `~/.modelrelay.json`
- API key env overrides:
  - `NVIDIA_API_KEY`
  - `GROQ_API_KEY`
  - `CEREBRAS_API_KEY`
  - `SAMBANOVA_API_KEY`
- `OPENROUTER_API_KEY`
- `OPENCODE_API_KEY`
- `OLLAMA_API_KEY`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL`
  - `CODESTRAL_API_KEY`
  - `HYPERBOLIC_API_KEY`
  - `SCALEWAY_API_KEY`
  - `KIRO_REFRESH_TOKEN`
  - `KIRO_OAUTH_CLIENT_ID` (optional, for AWS Builder/IDC refresh flow)
  - `KIRO_OAUTH_CLIENT_SECRET` (optional, for AWS Builder/IDC refresh flow)
  - `GOOGLE_API_KEY`

Kiro OAuth notes:
- Base endpoint is preconfigured to `https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse`
- Current Kiro model IDs include `claude-sonnet-4.5` and `claude-haiku-4.5`
- Authentication uses OAuth access tokens refreshed from:
  - `KIRO_REFRESH_TOKEN`, or
  - `~/.aws/sso/cache` (auto-detected refresh token), following OmniRoute’s approach.

For hosted Ollama, set `OLLAMA_API_KEY` and optionally override `OLLAMA_BASE_URL` / `OLLAMA_MODEL`.
If you leave the Ollama base URL blank in the UI, modelrelay defaults to `https://ollama.com/v1`.
With a valid Ollama API key, modelrelay will discover available Ollama models automatically.
If you point Ollama at a local host such as `http://127.0.0.1:11434`, modelrelay will also auto-discover models and does not require an API key.

### OpenAI-Compatible endpoints

modelrelay supports configuring multiple OpenAI-compatible upstream endpoints (vLLM, llama.cpp, custom relays, etc.). Each endpoint exposes a single model id and is routed independently.

- In the Web UI, click `+ Add Endpoint` under the **OpenAI-Compatible endpoints** group, supply a name, base URL, model id, and optional API key. Each endpoint then gets its own provider row with status, ping, and rate-limit information.
- modelrelay automatically probes `/v1/models` on each endpoint and exposes every returned model as a routable row. The manually configured model id (if any) is merged in as a fallback. Discovery is on by default and can be toggled per-endpoint with the **"Discover models from `/v1/models`"** checkbox.
- Endpoints are stored in `~/.modelrelay.json` under composite keys like `openai-compatible:my-vllm`:
  ```jsonc
  {
    "apiKeys": {
      "openai-compatible:my-vllm": "sk-…",
      "openai-compatible:groq-clone": "sk-…"
    },
    "providers": {
      "openai-compatible:my-vllm":    { "enabled": true, "name": "Local vLLM", "baseUrl": "http://localhost:8000/v1", "modelId": "qwen-coder" },
      "openai-compatible:groq-clone": { "enabled": true, "name": "Groq Clone", "baseUrl": "https://example/v1",        "modelId": "llama-3.3-70b" }
    }
  }
  ```
- Legacy single-endpoint configs (a bare `openai-compatible` entry without an instance suffix) are migrated automatically to `openai-compatible:default` on first run.
- The legacy env vars `OPENAI_COMPATIBLE_API_KEY` / `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_MODEL` continue to work and apply to the `:default` instance.
- Endpoints can also be managed via the API: `POST /api/openai-compatible/endpoints` (body: `{name, baseUrl, modelId, apiKey?}`) and `DELETE /api/openai-compatible/endpoints/<id>`.

### Config migration (CLI + Web UI)

- In the Web UI, open `Settings` -> `Configuration Transfer` to export/copy/import a token.
- The token includes your full config (including API keys, provider toggles, pinning mode, bans, filter rules, and auto-update settings).
- Treat tokens as secrets. Anyone with the token can import your keys/settings.
- Alternative: copy the config file directly from `~/.modelrelay.json` to the other machine at the same path (`~/.modelrelay.json`).

## Troubleshooting

### Clicking the update button or running `modelrelay` won't perform an update

To trigger a manual npm update and restart the service, run:

```bash
npm i -g modelrelay@latest
modelrelay autostart --start
```

### Testing updates locally without publishing to npm

You can point the updater at a local tarball instead of the npm registry:

```bash
npm pack
MODELRELAY_UPDATE_TARBALL=./modelrelay-1.8.3.tgz pnpm start
```

If you want the Web UI to always show an update while testing, set a higher forced version:

```bash
MODELRELAY_FORCE_UPDATE_VERSION=9.9.9
```

If the tarball filename does not contain a semantic version, also set:

```bash
MODELRELAY_UPDATE_VERSION=1.8.3
```

When `MODELRELAY_UPDATE_TARBALL` is set, the Web UI update flow and `modelrelay update`
install from that tarball and bypass the normal Git checkout update block. This is for
local testing only. `MODELRELAY_FORCE_UPDATE_VERSION` only affects version detection; the
actual install still comes from the tarball path.

---

⭐️ If you find modelrelay useful, please consider [starring the repo](https://github.com/ellipticmarketing/modelrelay)!
