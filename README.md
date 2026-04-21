# OpenCode Go Responses Proxy

A lightweight Node.js gateway that translates the [OpenAI Responses API](https://platform.openai.com/docs/api-reference/responses) to the OpenCode Go `chat/completions` endpoint. Supports streaming and non-streaming requests, tool calling, reasoning content, and multi-model routing.

## What it does

- Exposes `/v1/responses` (OpenAI Responses API format)
- Forwards to OpenCode Go's `/chat/completions` endpoint
- Handles SSE streaming with automatic reconnect and client disconnect abort
- Supports function calling, reasoning text, refusals, and image inputs
- Enforces per-model capability limits (tools, reasoning, max tokens, param allowlists)
- Maintains conversation threads via `previous_response_id` for multi-turn chat

## Requirements

- Node.js 20+ (for native `fetch` and `AbortController`)
- An OpenCode Go API key in `~/.local/share/opencode/auth.json` or via `OPENCODE_GO_API_KEY`

## Quick start

```bash
# Run the proxy
node opencode-gateway.mjs

# Proxy listens on http://127.0.0.1:4141 by default
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `OPENCODE_GO_API_KEY` | — | API key (overrides auth file) |
| `OPENCODE_GO_MODEL` | `kimi-k2.6` | Default model when client omits `model` |
| `OPENCODE_GO_BASE_URL` | `https://opencode.ai/zen/go/v1` | Upstream base URL |
| `KIMI_PROXY_HOST` | `127.0.0.1` | Proxy bind address |
| `KIMI_PROXY_PORT` | `4141` | Proxy port |
| `KIMI_PROXY_UPSTREAM_TIMEOUT_MS` | `120000` | Upstream request timeout (ms) |
| `OPENCODE_GO_MODEL_CAPABILITIES` | — | Override model capability map (JSON) |

## Minimal Codex config snippet

Add these lines to your existing `~/.codex/config.toml`:

```toml
model = "kimi-k2.6"
model_provider = "opencode-kimi-proxy"

[model_providers.opencode-kimi-proxy]
base_url = "http://127.0.0.1:4141/v1"
wire_api = "responses"
```

That is the minimum required. The rest of the settings below are optional tuning.

## Full Codex CLI configuration

Create `~/.codex/config.toml` (or pass `--config`):

```toml
model = "kimi-k2.6"
model_provider = "opencode-kimi-proxy"
model_context_window = 262144

# Leave room for Kimi's 65,536-token output ceiling
model_auto_compact_token_limit = 196608

[model_providers.opencode-kimi-proxy]
name = "OpenCode Go Kimi Proxy"
base_url = "http://127.0.0.1:4141/v1"
env_key = "KIMI_PROXY_KEY"
wire_api = "responses"
request_max_retries = 2
stream_max_retries = 6
stream_idle_timeout_ms = 300000
```

Run Codex:

```bash
codex
```

## Running proxy + Codex in one command

Use a subshell or process manager. With `bash`:

```bash
(
  node opencode-gateway.mjs &
  PROXY_PID=$!
  sleep 2
  codex "$@"
  EXIT=$?
  kill $PROXY_PID 2>/dev/null
  exit $EXIT
)
```

Or with ` concurrently` / `npm-run-all` (if you prefer):

```json
{
  "scripts": {
    "proxy": "node opencode-gateway.mjs",
    "codex": "codex",
    "dev": "concurrently \"npm run proxy\" \"sleep 2 && npm run codex -- $@\""
  }
}
```

## Model capabilities

The proxy ships with a built-in capability map. You can override it entirely via `OPENCODE_GO_MODEL_CAPABILITIES`:

```bash
OPENCODE_GO_MODEL_CAPABILITIES='{
  "kimi-k2.6": {
    "tools": true,
    "reasoning": true,
    "vision": true,
    "json_mode": true,
    "max_output_tokens": 65536,
    "context_window": 262144,
    "supported_params": ["temperature","top_p","presence_penalty","frequency_penalty","max_tokens","stop","seed","n","response_format"]
  }
}' node opencode-gateway.mjs
```

Built-in models:

| Model | Tools | Reasoning | Vision | Max output | Context |
|---|---|---|---|---|---|
| `kimi-k2.6` | ✓ | ✓ | ✓ | 65,536 | 262,144 |
| `kimi-k2.5` | ✓ | ✓ | ✓ | 16,384 | 256,000 |
| `deepseek-v3` | ✓ | ✓ | — | 8,192 | 64,000 |
| `qwen2.5-72b` | ✓ | — | — | 8,192 | 128,000 |
| `gpt-4o` | ✓ | — | ✓ | 16,384 | 128,000 |
| `gpt-4o-mini` | ✓ | — | ✓ | 16,384 | 128,000 |

Unknown models fall back to conservative defaults (no tools, no reasoning, 8k output, 128k context).

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/healthz` | Health check + upstream config |
| `GET` | `/v1/models` | List available models from capability map |
| `POST` | `/v1/responses` | OpenAI Responses API |

## Architecture

```
┌─────────┐     /v1/responses      ┌──────────────┐     /chat/completions     ┌─────────────┐
│  Codex  │ ──────────────────────> │  This proxy  │ ────────────────────────> │ OpenCode Go │
│  (CLI)  │  (Responses API format) │  (Gateway)   │  (chat/completions fmt) │  (Upstream) │
└─────────┘                         └──────────────┘                         └─────────────┘
```

The proxy:
1. Receives OpenAI Responses API requests (`input`, `tools`, `previous_response_id`, etc.)
2. Normalizes content and rebuilds messages as `chat/completions` format
3. Enforces model capability limits (strips unsupported params, caps tokens)
4. Forwards to upstream and translates the response back to Responses API events
5. Stores conversation threads for `previous_response_id` continuity

## Notes

- The upstream `/v1/models` endpoint on OpenCode Go returns 404, so the proxy uses a static capability map instead of discovery.
- Reasoning content is cached per tool-call ID for multi-turn tool loops.
- Conversation threads are stored in-memory (LRU, max 100). Restarting the proxy loses thread history.
