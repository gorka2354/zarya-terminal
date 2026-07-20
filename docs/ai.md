# AI Assistant

Zarya is bring-your-own-key: it never ships a bundled model or a bundled API key.
Everything under Settings → AI configures one `AiSettings` object
(`src/shared/types.ts`), and every actual network call to a provider happens in the
**main process** (`src/main/aiProxy.ts`) — a raw API key is read from encrypted storage
right before the request and is never sent across the IPC boundary to the renderer.

## Providers

```ts
type AiProviderKind = 'anthropic' | 'openai' | 'ollama' | 'openai-compat'
```

| Provider | Base URL | Key required | Notes |
|---|---|---|---|
| `anthropic` | `https://api.anthropic.com` (or override `baseUrl`) | Yes | Native `/v1/messages` streaming, incl. tool use |
| `openai` | `https://api.openai.com/v1` (or override) | Yes | Chat Completions streaming, incl. function calling |
| `ollama` | `http://127.0.0.1:11434` by default (`OLLAMA_DEFAULT_URL`) | No | Talks to Ollama's OpenAI-compatible `/v1` surface; `baseUrl` can point anywhere reachable — see below |
| `openai-compat` | **required**, no default | Depends on the endpoint | Any server implementing the OpenAI Chat Completions API (LM Studio, vLLM, LiteLLM proxies, etc.) |

Model presets shown in the settings UI (`AI_MODEL_PRESETS` in `src/shared/defaults.ts`):
Anthropic ships `claude-sonnet-5`, `claude-opus-4-8`, `claude-haiku-4-5-20251001`;
OpenAI ships `gpt-5.2`, `gpt-5.2-mini`, `o4-mini`. Ollama and `openai-compat` have no
fixed preset list — for Ollama, Zarya calls `GET {baseUrl}/api/tags` at connect time
(`ai:ollama-models`) and lists whatever's actually installed.

### Using a remote Ollama box

Because `baseUrl` is just a URL, Ollama doesn't have to be on the same machine. A
common setup: point Zarya at a beefier box on your LAN or [Tailscale](https://tailscale.com/)
network running `ollama serve`:

```
Provider:  ollama
Base URL:  http://<your-host>:11434
```

No API key needed — Ollama has none by default. Model list refreshes from that host's
`/api/tags`.

### API keys

Set per-provider via `settings:set-secret` → `SettingsStore.setSecret()`
(`src/main/settingsStore.ts`):

- If `safeStorage.isEncryptionAvailable()` (true on a normal desktop session — Windows
  DPAPI, macOS Keychain, Linux Secret Service via libsecret), the key is encrypted and
  stored as `enc:<base64>` in `secrets.json`.
  DPAPI/Keychain-backed encryption is tied to the OS user account, so the file is
  useless if copied to another machine or read by another OS user.
- If encryption is unavailable (rare — a headless/misconfigured environment), Zarya
  **still stores the key** rather than refusing to work, but base64-only as
  `b64:<base64>` — recoverable by anyone who can read the file. This fallback exists so
  the app degrades instead of breaking, not because it's considered secure; prefer a
  normal desktop session.
- `settings:provider-status` only ever returns `{ provider, hasKey: boolean }` — never
  the key material, so the renderer/UI can show "connected" state safely.

## Agentic mode & command safety

The transport (`AiChatRequest` / `AiStreamEvent` in `src/shared/types.ts`) is
tool-calling-capable end to end: a request can include `tools: AiToolDef[]` (JSON
Schema-defined), and the normalized stream from *either* Anthropic or an
OpenAI-compatible backend surfaces `{ type: 'tool_use', id, name, input }` events
identically, so the agent loop in the renderer doesn't need provider-specific branches.
Tool results are round-tripped back as `{ type: 'tool_result', toolUseId, content,
isError? }` content parts on the next turn.

**The safety model is explicit, not implicit:**

```ts
autoApprove: boolean  // AiSettings — "Auto-approve agent command execution
                       //  (dangerous, off by default)"
```

- By default (`autoApprove: false`), any command the assistant wants to run is
  surfaced to you for confirmation before it executes — the assistant proposes, you
  decide.
- Turning `autoApprove` on lets the agent execute proposed commands without a prompt.
  This is opt-in and explicitly documented as dangerous in the setting itself — only
  enable it for a workflow/model you trust, and prefer leaving it off for anything that
  touches files, git state, or network requests you haven't reviewed.

## Where the assistant is reachable

- **AI panel** (`Ctrl+Shift+A`) — the main chat surface.
- **Inline command bar** (`Ctrl+I`, `ai.command-bar` action) — natural language → a
  shell command, without leaving the terminal, scoped to the currently focused session.
- **Ask about a block** — the **✦** button on any command block
  (`src/renderer/src/components/BlocksPanel.tsx`) opens the AI panel with that block's
  command, output and exit code as context. This is the fastest path to "why did this
  fail" — click ✦ on a red-exit-code block right after a failure.

All three are decoupled from the AI feature implementation itself via a small bridge
interface (`src/renderer/src/features/ai/aiBridge.ts`) so the terminal core doesn't
hard-depend on it.

## What data leaves your machine

Only what you explicitly send reaches the configured provider — Zarya does not
background-upload session data. Concretely, a chat request's context is built from:

- Your typed message(s) in the panel/command bar.
- The last **`contextBlocks`** command blocks of the active session (default **3**,
  configurable in Settings → AI) — each block's command, output and exit code.
- Your `systemPromptExtra` (free text you write in Settings → AI, appended to the
  system prompt) — empty by default.
- If the agent is mid tool-use loop: the tool call and its result content.

To limit exposure:

- Lower `contextBlocks` (or set it to 0) to stop automatic block attachment entirely —
  you can still paste specific output manually.
- Keep `autoApprove` off so nothing runs without your eyes on it first.
- Prefer `ollama` with a local model for anything you don't want leaving the machine
  at all — no network call happens outside your own host in that case.
- Avoid putting secrets in `systemPromptExtra` — it's sent with every request.
