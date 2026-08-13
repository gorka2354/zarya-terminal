<div align="center">

# ЗАРЯ · Zarya

**A CLI agent that reads like first light. A new dawn for your terminal.**

*Zarya (Заря) — “dawn”: the twenty minutes before sunrise, when there is
exactly enough light to work by.*

[![License: MIT](https://img.shields.io/badge/license-MIT-ffb05c.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.7.5%20%22Rewind%22-ffb05c.svg)](CHANGELOG.md)
[![Languages](https://img.shields.io/badge/UI-English%20%7C%20%D0%A0%D1%83%D1%81%D1%81%D0%BA%D0%B8%D0%B9-4fd6d6.svg)](#language)
[![Electron](https://img.shields.io/badge/Electron-43-4fd6d6.svg)](https://www.electronjs.org/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-5fb88a.svg)](#install)
[![CI](https://github.com/gorka2354/zarya-terminal/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/gorka2354/zarya-terminal/actions/workflows/ci.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-e0b15a.svg)](CONTRIBUTING.md)

Zarya is an AI-native terminal named after the dawn — and it reads like one. It runs **Claude Code
natively** — the full agent, its tools and its permission prompts, driven straight
from your terminal — and gives every **pane its own agent**, so four CLIs can work
side by side without ever sharing a conversation. Warp-style command blocks,
persistent sessions and an optional built-in editor come along. 100% on your machine,
no account, no telemetry.

![Zarya](docs/img/hero.png)

</div>

## Highlights

- **🛰 Native Claude Code** — not a chat box bolted on. Zarya drives the real Claude
  Code agent through the Agent SDK: streaming replies, tool calls with inline
  approve/deny, the `AskUserQuestion` choice widget, session **resume**, and a live
  **fuel gauge** of your subscription limits — signed in with your **Max plan, no API
  key**.
- **▦ Panes are whole CLIs** — split the window and each pane keeps its own feed, its
  own input line, its own mode and its own autopilot. One Enter approves a tool in the
  **framed** pane and nowhere else. The sidebar lists the panes of the active desk, so
  you can point at one with the mouse; drag a pane by its header to move it next to
  another (the edge you aim at lights up) or into the list to give it a desk of its own —
  without killing the process.
- **👁 Who is waiting for you** — a working agent and an agent standing at a permission
  prompt are two different states, and Zarya says so: the sidebar counts who is
  **waiting** and for how long, the waiting pane pulses, and when the window is not in
  focus you get one system notification per stop — never a stream. Turned off with a
  single checkbox.
- **🧰 Tools you can see** — **Settings → Tools** lists the MCP servers of a chosen pane
  with their real state, the engine's own words for a failure, what each one costs you
  in tokens **per request**, and buttons to reconnect or turn one off. The tools of 14
  servers can quietly eat half your context; now that number is on screen.
- **📊 Skills, priced** — the same tab prices every skill you have. A skill's
  description sits in the context of *every* request, so it is billed whether it fires
  or not: on the author's machine that is 83 skills and **5,347 tokens per request**.
  Next to the price is what actually fired, counted on your machine and stored nowhere
  else — plus the blunt answer to "what can I turn off": *"82 never fired, ~4,986
  tokens"*. Each one has the four states Claude Code itself supports (in play · name
  only · by "/" only · off). Where a switch would not work — plugin skills, or a skill
  overridden by project settings — there is no switch, just the name of the file that
  overrode it.
- **🌅 Model & effort** — a console for picking the model and reasoning
  effort (`LOW` → `MAX`), with every current Claude version, live-switchable
  mid-session.
- **🎙 Dictation — offline speech-to-text** — hold `Ctrl+Shift+Space`, speak, and the
  text lands in the input. Runs entirely on your machine ([sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx)
  + [GigaAM](https://github.com/salute-developers/GigaAM), strong on Russian): no
  network, no cloud key, and the audio is never written to disk. Recognised text is
  **inserted, not sent** — you read it before Enter.
- **▚ Command blocks** — every command becomes a navigable block with output, exit
  code and duration, on the open OSC 133 standard.
- **💾 Persistent sessions** — scrollback, blocks and agent conversations survive a
  reboot; each conversation is bound to its terminal and its folder.
- **🧩 IDE as an add-on** — a Monaco editor, file tree and git diff you can switch on;
  **off by default**, so the base stays a clean terminal + agent.
- **🌐 Two languages, one build** — the entire interface is English or Russian, switched
  instantly in settings, no restart and no second installer. Follows your system
  language on first launch; the built-in agent answers in the language you picked.
- **🌅 Light with a direction** — the interface is named after the dawn, and reads
  like one: cold ground, a single warm signal that means "Enter lands here", and a
  window that has a bottom. 11 themes as hours of light, dark and light.

## Language

Zarya ships both languages inside one build. On first launch it follows your system
language; **Settings → Appearance → Language** pins English or Russian either way, and
the switch takes effect immediately — the dictionaries are already in the app, so
there is nothing to download, restart or sign into again.

The framing is translated rather than dropped: the model picker, the
`// FIRST LIGHT` tagline and the light-hour themes (Night, Embers, Sand, Tracing)
read as themselves in English. The
built-in agent is told to answer in the interface language, and so do the system
dialogs the main process shows.

Your own data is never translated: terminal output, agent answers, paths, session
names and command history stay exactly as you typed or received them.

Release notes and the changelog exist in both languages —
[CHANGELOG.md](CHANGELOG.md) in English, [CHANGELOG.ru.md](CHANGELOG.ru.md) in Russian.

## Native Claude Code

Point the bottom bar at **Claude Code** (or just type `claude`) and Zarya becomes a
native GUI front-end for the agent — no terminal-scraping, no second chat window:

- **Signed in with your Max subscription** — the bundled CLI is driven over the Agent
  SDK's JSON control protocol; there is no API key to paste and nothing leaves your
  machine that wouldn't already via `claude`.
- **Real tools, real prompts** — `Bash`, `Edit`, `Write`, web fetch and the rest run in
  the agent, and each tool call surfaces as a card you **approve or deny** (Enter · Esc).
  The signature `AskUserQuestion` renders as a native multiple-choice widget, not text.
- **Resume anything** — past sessions for the current folder are one click away, and the
  next turn resumes with full context intact.
- **Dynamic models & effort** — the model list, per-model effort levels and **ultracode**
  come straight from the SDK, so new models appear without an update. Switch live: the
  change applies from your next message.
- **Fuel gauge** — a real read of your 5-hour / 7-day subscription utilization, plus the
  active model and effort, right above the input.
- **Engine commands via `/`** — type a slash and the list comes from the agent itself
  (`/review`, `/compact`, your own skills), not from a constant in our source that ages
  with every release. An engine that does not name its commands says so instead of
  showing an empty list.
- **Bypass mode** — an optional switch that auto-approves ordinary tools (AskUserQuestion
  still always asks). Off by default; a one-click chip, live-toggleable.
- **"Allow for this session" — with a floor** — between "ask every time" and "ask
  nothing" there is now a third button, and it shows the exact rule it will create.
  What it will never cover: `rm -rf`, `git push --force`, `DROP TABLE` and their kin
  are shown before every run, autopilot or not. This is not a sandbox and we do not
  call it one — there is no OS isolation here, only a promise about what Zarya always
  puts in front of you.
- **New skills and MCP without a restart** — install a server or a skill and the running
  session picks it up on one click, keeping the conversation. No "please restart".

Prefer to bring your own key? Zarya also has a **built-in provider agent** that talks to
**Anthropic**, **OpenAI**, **Ollama** (local inference, incl. a remote Ollama box on your
LAN or Tailscale) or any **OpenAI-compatible** endpoint — keys encrypted at rest, never
sent anywhere but the provider you configured.

## Panes — four CLIs in one window

![Panes](docs/img/panes.png)

A tab is a **desk**, a pane is a **CLI**. Up to four panes share a desk; the fifth opens
a desk of its own, because past four the feed collapses into a strip of lines.

- **Nothing is shared.** Feed, input line, mode, autopilot, attachments, input history —
  all per pane. A full-screen program (`vim`, `htop`) takes over *its* pane only.
- **The frame never lies.** The accented border marks the pane that receives `Enter` and
  `Esc` — i.e. where a tool approval will land. The sidebar mirrors it: a subtle
  background means «on screen», the accent means «in focus», and there is exactly one.
- **Layout is a rule, not a chore.** One pane fills the desk, two-three go in columns,
  four make a 2×2 grid. Close one and the rest re-flow — unless you dragged a divider,
  in which case your layout is yours and stays untouched.
- **Move or detach.** Grab a pane by its header: drop it on another pane and it docks to
  the **edge you aim at** (the half it will take lights up first); drop it into the
  sidebar and it leaves the grid for its own desk. The process never restarts.
- **Desks have names.** Built from the panes («zarya-web + zarya-api +2») or your own —
  rename with a double click.

## Model & effort

<img src="docs/img/launchpad-tight.png" align="right" width="290" alt="Model and effort picker" />

The signature control — a console instead of a boring dropdown. Every
current Claude model is version-qualified (**Opus 5**, **Fable 5**, **Sonnet 5**,
**Haiku 4.5**) with a one-line purpose and a live "active" marker on whatever is
actually running. Pick an **engine** (model) and its **effort** (from `LOW`
to `MAX`, gated per model — the same names the CLI uses), flip **ULTRACODE** for xhigh + workflow
orchestration, and hit **APPLY** — a pixel sunrise marks the moment as the
settings apply.

The console stays a slim strip while you browse and only opens up when the choice is
applied, so the picker reads like the CLI's own `/model`. Open it from the model chip,
the limit strip, or `Ctrl+Alt+M`.

Everything is dynamic: the list, the effort levels and the default all come from the
SDK, so the pad is future-proof — the next model Anthropic ships just shows up.

<br clear="right" />

## The rest

### Ask-agent bar & modes
One input under the terminal, Warp-style: **Enter runs a shell command** by default,
`Shift+Enter` / `Ctrl+Enter` add a line. A chip switches the bar between **Terminal**
and the agents, and it auto-follows — launching an interactive CLI (`claude`, `vim`,
`ssh`, a TUI) flips into raw-terminal mode automatically. Message queueing, `↑/↓`
input history, `Esc` to interrupt and approve/deny keys are all there.

One figure of your limits — whichever window is closest to running out — lives in the
strip along the bottom of the window (one gauge per window, not per pane) and opens
the rest on click: a line per limit with its own gauge and reset time.
Engine and permission mode are icons; their labels live in tooltips, but the gate
**keeps its colour**, because «will I be asked?» must be readable without hovering.

### Dictation (voice input)
Click the microphone or hold `Ctrl+Shift+Space`. Click-mode stops itself after a
second and a half of silence; `Esc` cancels. While recording, the button **is** the
indicator — it pulses and shows the input level, because a microphone must never be
open without you knowing.

The model (~225 MB) is downloaded on first use with a checksum check, not bundled,
and cached under your user data. Everything after that is local: no request leaves
the machine, and the audio exists only in memory while you speak.

**Choosing the microphone.** Right-click the mic button (or Settings → Voice) to pick
the input device; the default follows your OS. The choice is stored with the device
name as well as its id, because Chromium's per-origin device ids change when a driver
is reinstalled — so the same headset is re-bound silently instead of dictation quietly
falling back to the laptop's built-in mic. If the device really is gone, Zarya says so
and records into the system default rather than failing or pretending.

**Your own model.** The built-in list is closed on purpose — a downloaded file goes
into a native engine, so a "paste a link" field would be a way to run someone else's
code. Instead, **Settings → Voice → Choose folder…** points Zarya at a
[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) model folder you already have
(whisper, transducer, moonshine, nemo-ctc, sense-voice, paraformer, zipformer,
dolphin, canary, fire-red). It recognises the layout, lists the model marked *yours*,
and dictates with it. Nothing is copied and nothing is downloaded; the path comes only
from the system dialog, and "Remove" drops the entry, never your files. When the
folder is ambiguous — a lone `model.onnx` looks the same for six families — Zarya
refuses instead of guessing and asks for a `zarya-model.json` naming the family.

Before a folder is accepted it is **started in a separate process**. That is not
caution for its own sake: handed an ONNX of the wrong shape, the native engine does
not return an error — it calls `exit(-1)` from a worker thread, which in the main
process would take the whole app down, panes and agents included, without a word.
So a model that does not build is refused in words — the engine's own, naming the
metadata it missed — and never reaches the process you work in.

### Update check
Zarya makes **one anonymous GET** to the GitHub releases API at startup — no token,
no identifiers, no telemetry — and shows a dot in the activity bar when a newer
version exists. Behind it: a **"What's new" page** with the release notes, the files
with their sizes, and the **SHA256** of each so you can verify what you downloaded.
Turn it off in Settings → About.

Zarya never downloads or launches anything on its own. Every URL on that page is
**built by the app** from a hardcoded repo constant and a validated tag — never
taken from the API response — and links inside the release notes are rendered
inert, because the only legitimate destinations are the ones Zarya constructs
itself.

One-click install is gated on a **release signature**. The checksum list of every
release is signed with an Ed25519 key that lives on the maintainer's machine and
is *not* in CI; the app carries the public half and refuses to self-install
anything it cannot verify — signature over the checksum list, then sha256 of the
downloaded installer against that list. Without it, the integrity chain would be
CI vouching for CI: a compromised pipeline would produce a valid checksum for a
compromised build, and with auto-update that is silent code execution on every
machine. An unsigned release is still installable — by hand, from the release
page, with the SHA256 shown next to each file. Note this is *not* Authenticode:
the executables themselves carry no certificate, so SmartScreen still warns.
Maintainer flow: `node scripts/gen-signing-key.mjs` once, then
`node scripts/sign-release.mjs <version>` after every release.

### Blocks
Every command becomes a distinct, navigable block — command, output, exit code and
duration, shown as an instrument-panel pill (`✓ 0 · 40ms` / `✗ 7 · 3.4s`) — on the open
[OSC 133](docs/shell-integration.md) standard, not a proprietary protocol. Jump with
`Ctrl+↑` / `Ctrl+↓`, re-run, copy command/output, or export as Markdown.

### Persistent sessions
Closing Zarya — or the machine losing power — doesn't lose your work: scrollback,
blocks and **agent conversations** autosave and restore, each conversation re-bound to
its terminal and cwd (so Claude Code resumes the right thread). Open a terminal straight
into a bookmarked project folder from the sidebar `▾` menu, `Ctrl+Shift+O`, or a folder
drag-drop. Model: [docs/sessions.md](docs/sessions.md).

### IDE add-on
An optional layer — **off by default** — that reveals a **Monaco** editor with a file
tree (git-status markers), a git diff view and a second built-in-provider agent. Toggle
it from the activity bar; the base app stays a clean terminal + Claude Code agent until
you opt in.

### Time Machine
Global, cross-session command history (`Ctrl+R`) — every command with cwd, shell and
exit code, fuzzy-searchable across sessions. It is bounded and switchable, both in
**Settings → Terminal**: a ceiling on how many entries are kept (20,000 by default —
older ones are dropped from the file, not just from the view), and a switch that stops
recording *and* stops answering — with the switch off, `Ctrl+R` and the terminal's
suggestions find nothing, immediately, not after a restart. There is a button to
erase the lot.

### Images
Paste (`Ctrl+V`) or drop a picture into the bar and it attaches to **that** pane, shows
as a chip before you send, and is scaled down to the model's limit. An engine that
cannot read images says so out loud instead of swallowing the attachment.

### More
Workflows (parameterized snippets), Command Palette (`Ctrl+Shift+P`), tabs and panes
(persisted across restarts), ghost autosuggest, and a `THEME` quick-cycle button.

### Themes — 11, read as hours of light

| Theme | Type | |
|---|---|---|
| Zarya · Blue Hour | dark | twenty minutes before sunrise (**default**) |
| Zarya · Night | dark | deep graphite, the darkest of the set |
| Zarya · Embers | dark | red-dominant, banked coals |
| Zarya · Ash | dark | cold graphite, muted brass |
| Zarya · Frost | dark | teal oscilloscope |
| Zarya · Sand | dark | warm amber over a dark steppe |
| Zarya · First Ray | dark | the original sunrise, kept as a warm option |
| Zarya · Golden Hour | **light** | morning on paper |
| Zarya · Paper | **light** | cream paper, red and black ink |
| Zarya · Noon | **light** | warm daylight |
| Zarya · Tracing | **light** | navy lines on cool paper |

Switch in Settings → Appearance, or cycle with the `THEME` button. Add your own via
`registerThemes()` — see [docs/themes.md](docs/themes.md).

The accent means *"Enter lands here"* and `danger` means the opposite, so a theme is
only finished when the two cannot be confused: `tests/themeSignals.test.ts` requires
contrast ≥ 1.5 and ≥ 30° of hue between them, both legible on their own ground, and
ANSI colours still true to their names.

## Keyboard shortcuts

Remappable in Settings → Keys (`Ctrl+,`). Full reference:
[docs/keybindings.md](docs/keybindings.md).

| Action | Default | | Action | Default |
|---|---|---|---|---|
| Command palette | `Ctrl+Shift+P` | | Model & effort | `Ctrl+Alt+M` |
| Quick open (file) | `Ctrl+P` | | AI: natural language → command | `Ctrl+I` |
| Settings | `Ctrl+,` | | Global command history | `Ctrl+R` |
| Toggle sidebar | `Ctrl+B` | | New terminal in folder | `Ctrl+Shift+O` |
| New / close tab | `Ctrl+Shift+T` / `Ctrl+Shift+W` | | Split right / down | `Ctrl+Shift+D` / `Ctrl+Shift+S` |
| Close pane | `Ctrl+Shift+X` | | Focus next pane | `Alt+→` |
| Previous / next block | `Ctrl+↑` / `Ctrl+↓` | | Find in terminal | `Ctrl+Shift+F` |
| Dictate (hold) | `Ctrl+Shift+Space` | | New line in the bar | `Shift+Enter` |

## Install

### Prebuilt (Windows)
Grab `Zarya-Setup-<version>-win-x64.exe` from the GitHub Releases page and run it — a
per-user installer, no admin required. `Zarya-Portable-<version>-win-x64.exe` is built
alongside it if you would rather not install anything.

### The `zarya` command (Windows)
`zarya .` opens a project from any terminal — and if Zarya is already running, the
folder arrives in the running window instead of starting a second one. The command is
not installed behind your back: **Settings → Terminal → the `zarya` command → Install**
drops two launcher scripts into `%LOCALAPPDATA%\Zarya\bin` and appends that one folder
to your user `PATH`. The same screen removes it, and it reports what the system
actually resolves the name to rather than what we tried to write. Terminals already
open see the command after a restart; panes inside Zarya see it immediately.

Without it, a project still opens by full path to the exe, by *Open with…* from the
file manager, or by dropping a folder on the icon.

### From source

```bash
git clone https://github.com/gorka2354/zarya-terminal.git
cd zarya-terminal
npm install
npm run dev          # development
npm run build        # bundle main/preload/renderer -> out/
npm run pack         # unpacked build -> release/win-unpacked
npx electron-builder # installer + portable -> release/
```

**Notes.** Node **20.19+** is required for dev and build (`engines` enforces it; CI runs
Node 22). Packaging uses **electron-builder 26**, which is what set that floor. On
macOS/Linux `electron-builder` produces a `.dmg` / AppImage + `.deb`. Native Claude Code needs the bundled `@anthropic-ai/claude-agent-sdk`
and an existing `claude` login (`claude` in a terminal, once).

## Architecture

Standard three-process Electron app: **main** owns OS resources (PTYs, filesystem, git,
API keys, and the Claude Code driver), **preload** exposes one typed, whitelisted
`window.zarya` bridge, and the **renderer** (React 19 + Zustand 5) owns all UI and never
touches Node directly.

```mermaid
flowchart LR
    subgraph Main["Main (Node)"]
        PTY[PtyManager]
        CC[ClaudeCodeDriver · Agent SDK]
        SESS[SessionStore + safeStorage]
        AI[AiProxy]
        FS[fsService / gitService]
        STT[SttService · sherpa-onnx]
    end
    subgraph Bridge["Preload"]
        API["window.zarya (typed IPC)"]
    end
    subgraph Renderer["Renderer (React + Zustand)"]
        FEED[MissionFeed · blocks + agent]
        BE[BlockEngine · OSC 133/6973]
        UI[LaunchPad · AgentBar · FuelGauge]
        IDE[Add-on: Files · Editor · Workflows]
    end
    PTY <--> API
    CC <--> API
    SESS <--> API
    AI <--> API
    FS <--> API
    STT <--> API
    API <--> FEED
    FEED --> BE
    UI --> FEED
```

Visual & functional QA runs through an **offscreen harness** (`scripts/*.mjs`,
Playwright-Electron in an isolated `ZARYA_USER_DATA` instance) — driving the renderer,
the driver and the PTY regardless of the screen. Full write-up + IPC list:
[docs/architecture.md](docs/architecture.md).

## Shell integration

On spawn Zarya injects an integration script (PowerShell / bash / zsh) that emits
standard **OSC 133** prompt/command marks plus a private, nonce-signed **OSC 6973**
sequence carrying the exact command line — powering Blocks, Time Machine and cwd
tracking. `cmd.exe`, Fish and WSL run without integration.
Details: [docs/shell-integration.md](docs/shell-integration.md).

## Security & privacy

- **No account, no telemetry.** Nothing about you or your work is collected, and there
  is no analytics endpoint anywhere in the code. Zarya makes exactly three kinds of
  outbound request, all of them nameable: to the AI provider you configure; to GitHub
  to look for a new version (one anonymous request at launch — switch it off in
  **Settings → Updates**); and to `huggingface.co` if you ask it to download a speech
  model. Native Claude Code uses your existing `claude` login.
- **API keys are encrypted at rest when the OS can do it** — Electron `safeStorage`
  (DPAPI / Keychain / Secret Service). When it cannot, the key is stored base64-encoded,
  which is *not* protection, and the settings screen says so in as many words
  ("Key in plain text"). See [SECURITY.md](SECURITY.md) for what each state means.
  Either way the key goes nowhere but the provider you set.
- **Hardened renderer** — `contextIsolation` + `sandbox`, a strict CSP (`script-src
  'self'`, no inline/eval), navigation locked to its own origin, and DOMPurify on all
  AI/tool output.
- **Untrusted repos** — the auto-run `git status`/diff neutralizes exec-capable
  repo-local config (`core.fsmonitor`, hooks, …) so opening a malicious folder can't run
  code in the main process.
- **Approval gates you can actually read.** One switch per engine weakens a gate and
  the bar always shows which; every request gets a card, and while it waits for your
  answer the command is pinned open — no fold, no ellipsis, no inner scrollbar.
- **Voice stays on the machine.** Recognition is local; the microphone opens only on an
  explicit action, is visibly indicated while open, and closes with the take. Browser
  permissions are an explicit allow-list (microphone + clipboard, this window only).
- **Terminal profiles** — a stored profile is a program the app will launch, so adding
  or editing one needs your confirmation, with the path, arguments and environment
  shown.
- Terminal scrollback, history and conversations are stored **in cleartext** by design
  (only keys are encrypted) — see [SECURITY.md](SECURITY.md) for the threat model and how
  to disable persistence on shared machines.

## Tests

Numbers as of 0.7.5: **989 unit checks** (plus 6 skipped on this platform) across
76 files and **111 end-to-end runs**
that drive the real application.

**Unit** (`tests/`, vitest) — the pure logic where a silent mistake costs the most:
the pane-layout rules, the approval-gate labels a person presses Enter on, the
download-progress parsing (including its refusal to draw a bar over a coverage
report), the project list order and path comparison, key-protection classification,
shell-profile validation, and the completeness of both language dictionaries.

**End-to-end** (`scripts/*.mjs`, Playwright driving Electron) — the real app in a
throwaway profile, never touching your sessions or settings — and offscreen, so a run
never steals focus while you work. Panes (140 checks), the language switch across every
screen (10), download progress and the tool clock (16), the agent engines on a
protocol-accurate fake driver (21), the model picker (41), the update page (30), menus
(27), key badges (9), command history and its off switch (13), who is waiting for you
and when Zarya may call (11), the floor under autopilot (26), the health of the agent's
MCP servers (27), the skills tab (49), writing skill state into Claude Code's own
settings on a redirected home (14), the usage counter across restarts (12), pane
signals (36), and the first-run screen (18). Plus `npm run perf`, which measures drag,
streaming and gutter latency against fixed budgets.

```bash
npm test              # unit tests
npm run qa:progress   # one end-to-end run (build + drive the app)
npm run perf          # performance budgets
```

**What CI does and does not do.** Every push runs typecheck, the unit tests and a
build on Ubuntu and Windows, plus **nineteen** end-to-end runs on a real Electron
window under xvfb: panes, the language switch, download progress, the agent engines on
a fake driver, importing a speech model from disk (folder recognition and its
refusals — no weights are downloaded), the key router (`Enter` in a rename dialog
must not also approve a tool waiting in a pane), sidebar folding, the difference
between "working" and "waiting for you", the floor under autopilot, the MCP health
panel, the three skill runs (what the tab shows, what gets written into Claude Code's
own settings, and the usage counter's life across restarts), per-pane routing of engine
commands, the palette, per-pane model and effort, the pane signals (seam, state stripe,
one header), find-in-feed, and the first-run screen. The rest — the speech
engine on real weights, the real Claude Code driver, the update page, performance
budgets — need network, hardware or a live agent, so they stay manual before a
release. A green tick therefore means *types check,
unit tests pass, the app builds and its main screens survive being driven*, but
not that every corner was walked. The distinction is spelled out on purpose: a
badge that implies more than it verifies is the same kind of lie this project
tries not to tell in its interface.

## Contributing

Dev setup, code style, adding a theme/workflow/provider: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). Bundled fonts (Pixelify Sans, Handjet, PT Sans, JetBrains
Mono) are under the [SIL Open Font License 1.1](https://openfontlicense.org/).
