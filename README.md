# modelrelay

OpenAI-compatible local router that benchmarks free coding models across providers and forwards requests to the best available model.

## Install

```bash
npm install -g modelrelay
```

## Quick Start

```bash
# 1) Onboard: save provider API keys and optionally auto-configure integrations
modelrelay onboard

# 2) Start the local router (default port 7352)
modelrelay
```

Router endpoint:

- Base URL: `http://127.0.0.1:7352/v1`
- API key: any string
- Model: `auto-fastest` (router picks actual backend)

## OpenCode Quick Start

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

## OpenClaw Quick Start

`modelrelay onboard` can auto-configure OpenClaw.

If you want manual setup, merge this into `~/.openclaw/openclaw.json`:

```json
{
  "models": {
    "providers": {
      "modelrelay": {
        "baseUrl": "http://127.0.0.1:7352/v1",
        "api": "openai",
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

## CLI

```bash
modelrelay [--port <number>] [--log] [--ban <model1,model2>]
modelrelay onboard [--port <number>]
modelrelay install --autostart
modelrelay start --autostart
modelrelay uninstall --autostart
modelrelay status --autostart
modelrelay update
modelrelay autostart [--install|--start|--uninstall|--status]
```

Request terminal logging is disabled by default. Use `--log` to enable it.

`modelrelay install --autostart` also triggers an immediate start attempt so you do not need a separate command after install.

During `modelrelay onboard`, you will also be prompted to enable auto-start on login.

`modelrelay update` upgrades the global npm package and, when autostart is configured, stops the background service first and starts it again after the update.

## Config

- Router config file: `~/.modelrelay.json`
- API key env overrides:
  - `NVIDIA_API_KEY`
  - `GROQ_API_KEY`
  - `CEREBRAS_API_KEY`
  - `SAMBANOVA_API_KEY`
  - `OPENROUTER_API_KEY`
  - `CODESTRAL_API_KEY`
  - `HYPERBOLIC_API_KEY`
  - `SCALEWAY_API_KEY`
  - `GOOGLE_API_KEY`
