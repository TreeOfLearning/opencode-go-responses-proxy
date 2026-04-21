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

| Model | Context Window | Max Output | Input $/1M | Output $/1M | Tools | Reasoning | Vision |
|---|---|---|---|---|---|---|---|
| `kimi-k2.6` | 262,144 | 65,536 | $0.32 | $1.34 | ✓ | ✓ | ✓ |
| `kimi-k2.5` | 262,144 | 65,536 | $0.60 | $3.00 | ✓ | ✓ | ✓ |
| `glm-5` | 204,800 | 131,072 | $1.00 | $3.20 | ✓ | ✓ | — |
| `glm-5.1` | 204,800 | 131,072 | $1.40 | $4.40 | ✓ | ✓ | — |
| `qwen3.5-plus` | 262,144 | 65,536 | $0.20 | $1.20 | ✓ | ✓ | ✓ |
| `qwen3.6-plus` | 262,144 | 65,536 | $0.50 | $3.00 | ✓ | ✓ | ✓ |
| `mimo-v2-pro` | 1,048,576 | 64,000 | $1.00 | $3.00 | ✓ | ✓ | — |
| `mimo-v2-omni` | 262,144 | 64,000 | $0.40 | $2.00 | ✓ | ✓ | ✓ |
| `minimax-m2.5` | 204,800 | 65,536 | $0.30 | $1.20 | ✓ | ✓ | — |
| `minimax-m2.7` | 204,800 | 131,072 | $0.30 | $1.20 | ✓ | ✓ | — |

**Notes:**
- Vision support includes image and video input on Kimi and Qwen models; MiMo V2 Omni also supports audio and PDF input.
- MiMo V2 Pro has experimental over-200K pricing: input $2.00, output $6.00 per 1M tokens.
- MiMo V2 Omni and MiMo V2 Pro offer `low`, `medium`, and `high` reasoning-effort variants.
- Token limits are enforced by the proxy's capability map. You can override any model's limits via `OPENCODE_GO_MODEL_CAPABILITIES`.
- Unknown models fall back to conservative defaults (no tools, no reasoning, no vision).

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
