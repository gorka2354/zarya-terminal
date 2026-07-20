# Changelog

All notable changes to Zarya are documented here. This project uses
[Semantic Versioning](https://semver.org/).

## 0.1.0 (2026-07-20)

Initial release.

### Added

- **Terminal core** — xterm.js 6 with WebGL rendering (DOM fallback on context loss),
  find-in-terminal, clickable web links, Unicode 11 support, per-pane split/tab layout
  with drag-resizable gutters.
- **Blocks** — Warp-style command blocks driven by the OSC 133 shell-integration
  standard: per-command output capture, exit-code badges, duration, re-run, copy
  command/output, export as Markdown, and `Ctrl+↑`/`Ctrl+↓` navigation between blocks.
- **Shell integration** — bundled PowerShell (5.1 & 7+), bash and zsh integration
  scripts emitting OSC 133 (A/B/C/D), OSC 7/9;9/1337 (cwd), and a private,
  nonce-signed OSC 6973 channel for exact command-line capture; auto-detected shell
  profiles plus support for user-defined custom profiles.
- **Persistent sessions** — autosaved scrollback + blocks on an interval and on a
  graceful prepare-quit handshake; pin/favorite sessions; restore replays scrollback
  and blocks then starts a fresh shell in the saved directory; workspace (tabs +
  splits) restore on launch; 200-session prune policy exempting pinned/favorites.
- **AI Assistant** — provider-agnostic streaming transport (Anthropic, OpenAI, Ollama,
  any OpenAI-compatible endpoint) with the actual HTTP calls made from the main
  process so keys never cross into the renderer; encrypted key storage via
  `safeStorage`; tool-calling-capable agent transport with an explicit,
  off-by-default `autoApprove` safety gate; inline natural-language-to-command bar;
  per-block "ask AI" action.
- **Time Machine** — append-only, cross-session global command history with
  fuzzy multi-token search.
- **Workflows** — parameterized, reusable command snippets with `{{param}}`
  templating, user-defined plus a bundled starter pack mechanism.
- **IDE-lite** — Monaco-based editor pane, file tree, git diff view (porcelain v2
  status + HEAD-vs-working-tree diff), and click-to-open for file paths detected in
  terminal output (with `:line[:col]` suffix support).
- **Command palette & keybindings** — a single action registry drives both a
  searchable command palette and a fully remappable, JSON-configurable keybinding map.
- **Themes** — a CSS-variable + xterm-palette theme engine (`ThemeDef`) shipping
  Zarya Dawn and Zarya Night, with a `registerThemes()` extension point for adding
  more.
- **Ghost autosuggest** — fish-style inline command suggestions from cross-session
  history, accepted with `→`.
- **Privacy by construction** — no telemetry, no account, no server component; all
  state lives under the OS `userData` directory; API keys encrypted at rest via the
  OS keychain (Windows DPAPI / macOS Keychain / Linux Secret Service).
