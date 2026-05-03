# modelrelay Docker Images

Custom Docker image with unmerged PRs + weekly sync with official releases.

## Image

```
ghcr.io/Rahulsharma0810/modelrelay:latest
```

## Unmerged PRs Included

| PR | Title | Status |
|----|-------|--------|
| #50 | Add AiHubMix as a new supported provider | Merged |
| #48 | Support multiple OpenAI-compatible upstream endpoints | Open |

## Building

### Local Build

```bash
docker build -t modelrelay-custom .
docker run -p 3000:3000 -e GROQ_API_KEY=your-key modelrelay-custom
```

### Docker Compose

```bash
# Create config file
cat > config.json << 'EOF'
{
  "apiKeys": {
    "groq": ["your-groq-key"],
    "cerebras": ["your-cerebras-key"],
    "aihubmix": ["your-aihubmix-key"]
  }
}
EOF

# Run
docker compose up -d
```

## CI/CD

The `.github/workflows/docker-build.yml` workflow:

- **Schedule**: Runs weekly (Sunday 00:00 UTC)
- **Cherry-picks**: All open PRs from this repo
- **Tags**: `sha-<short>` for each build, `latest` for newest

### Manual Trigger

```bash
gh workflow run docker-build.yml -f pr_list=50,48
```

## Updating

The workflow automatically:
1. Fetches latest from `upstream/master` (official releases)
2. Cherry-picks all open PRs
3. Runs tests
4. Builds and pushes image

No manual intervention needed for weekly updates.

## Environment Variables

```bash
GROQ_API_KEY=        # Groq API key
CEREBRAS_API_KEY=    # Cerebras API key  
AIHUBMIX_API_KEY=    # AiHubMix API key
NVIDIA_NIM_API_KEY=  # NVIDIA NIM API key
# ... any provider keys
```

## Config File

Mount a config file at `/home/node/.modelrelay.json`:

```json
{
  "apiKeys": {
    "groq": ["key1", "key2"]
  },
  "providers": {
    "groq": {
      "enabled": true,
      "pingIntervalMinutes": 30
    }
  }
}
```

## Ports

- `3000` - Web UI and API
- `7352` - Router endpoint (via `--port 7352`)