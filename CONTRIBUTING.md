# Contributing to Zarya

Thanks for considering it. This project is young and the codebase is small enough to
read end to end — that's intentional, keep it that way.

## Dev setup

Requirements: Node.js **20.19+** or **22+**, npm.

```bash
git clone https://github.com/gorka2354/zarya-terminal.git
cd zarya-terminal
npm install
npm run dev          # electron-vite dev — hot-reloads the renderer, restarts main on change
```

Other scripts (`package.json`):

```bash
npm run typecheck        # tsc --noEmit for both the node (main/preload) and web (renderer) projects
npm run typecheck:node    # just src/main + src/preload
npm run typecheck:web     # just src/renderer
npm test                  # vitest run — unit tests under tests/
npm run test:watch
npm run format             # prettier --write src/**/*.{ts,tsx,css}
npm run pack               # build + unpacked electron-builder output (fast, for local testing)
npm run dist                # build + full platform installer(s)
```

There are two separate `tsc` projects (`tsconfig.node.json` for main/preload,
`tsconfig.web.json` for the renderer) because they target different runtimes (Node vs.
browser/DOM) and must not accidentally share globals — keep that split in mind when
adding files: a file under `src/main` or `src/preload` cannot import DOM types, and a
file under `src/renderer` cannot import Node built-ins.

## Code structure

```
src/
├── shared/            # Cross-process contracts — THE source of truth
│   ├── types.ts        #   All shared TypeScript interfaces (Settings, BlockRecord, IPC payloads…)
│   ├── ipc.ts           #   IPC channel name constants (CH)
│   └── defaults.ts      #   DEFAULT_SETTINGS, DEFAULT_KEYBINDINGS, AI_MODEL_PRESETS
├── main/               # Node process — owns PTYs, disk, git, secrets, AI HTTP calls
│   ├── index.ts          #   App/window lifecycle, prepare-quit handshake
│   ├── ipc.ts             #   registerIpc() — wires every CH.* channel to a store/service
│   ├── ptyManager.ts      #   @lydell/node-pty spawn/write/resize/kill + shell-integration injection
│   ├── shellProfiles.ts    #   Shell auto-detection (pwsh/powershell/cmd/git-bash/wsl/zsh/bash/fish)
│   ├── settingsStore.ts    #   settings.json + safeStorage-encrypted secrets.json
│   ├── sessionStore.ts     #   sessions/*.json snapshots + workspace.json + prune
│   ├── historyStore.ts      #   history.jsonl append-only global history
│   ├── workflowStore.ts     #   workflows.json + bundled workflow packs
│   ├── aiProxy.ts            #   Anthropic / OpenAI-compatible streaming, normalized to AiStreamEvent
│   ├── fsService.ts          #   File tree / editor fs operations
│   ├── gitService.ts          #   git status / diff via child_process
│   └── jsonStore.ts            #   readJson / writeJsonAtomic / mergeDeep / debounce helpers
├── preload/
│   ├── index.ts          # contextBridge.exposeInMainWorld('zarya', api) — the ONLY main<->renderer surface
│   └── index.d.ts         # ZaryaApi type — keep in lockstep with preload/index.ts and main/ipc.ts
└── renderer/src/
    ├── state/             # Zustand stores: sessionsStore, blocksStore, settingsStore, uiStore
    ├── terminal/           # terminalRegistry, XtermView, BlockEngine (OSC parser), historyCache, termLinks
    ├── lib/                 # actionRegistry, bus (typed event bus), fuzzy, ansi, uid
    ├── actions/              # coreActions.ts — registers the built-in AppAction set
    ├── components/            # Chrome: Titlebar, ActivityBar, StatusBar, SplitLayout, TerminalPane…
    └── features/               # Self-contained feature modules (ai, editor, history, palette, themes, workflows, settings)
```

**Feature modules follow a bridge pattern** so the terminal core never hard-depends on
a specific feature: `src/renderer/src/features/ai/aiBridge.ts` and
`features/editor/editorBridge.ts` are tiny interfaces that a feature module registers
an implementation against on load (`registerAiBridge`, `registerEditorBridge`). If
you're building a new feature panel that the terminal core needs to call into (open a
file, explain a block, etc.), add a bridge rather than importing the feature module
directly from `terminal/`.

## Code style

- Prettier config is `.prettierrc.json` (no semicolons, single quotes, 100-char print
  width, no trailing commas) — run `npm run format` before committing;
  `npm run typecheck` is the CI-equivalent gate, there's no separate lint step.
  TypeScript is `strict: true` in both projects.
  - UI copy is Russian (`src/renderer/src/**` user-facing strings) — the app targets a
  Russian-speaking initial audience. Code, comments, commit messages and docs are
  English.
  - Prefer the existing `zy-*` CSS classes and CSS custom properties (`--bg`, `--panel`,
  `--accent`, `--border`, `--font-mono`, …) defined in
  `src/renderer/src/styles/{base,features}.css` over new one-off styles — the design
  system is intentionally small.

## Adding a theme

Themes are `ThemeDef` objects (`src/shared/types.ts`): a `ui` palette (drives CSS
variables via `applyTheme()`) and a `terminal` palette (the 16-color xterm palette +
background/foreground/cursor/selection, via `toXtermTheme()`).

1. Define a new `ThemeDef` — the two shipped themes in
   `src/renderer/src/features/themes/themes.ts` (`zaryaDawn`, `zaryaNight`) are the
   reference shape.
2. Call `registerThemes([yourTheme])` once, e.g. from
   `src/renderer/src/features/themes/themePack.ts` — `registerThemes` is idempotent
   per id (a duplicate id is silently skipped) so it's safe to call from module init.
3. It's now selectable via `settings.appearance.themeId` and shows up wherever
   `getThemes()` is enumerated.

## Adding a workflow

`WorkflowDef` (`src/shared/types.ts`): `id`, `name`, `command` (a template with
`{{param}}` placeholders), `params: WorkflowParam[]`, `tags`. User-defined workflows
round-trip through `workflows:save` / `workflows:delete` and are stored in
`workflows.json` under `userData`. To ship a **built-in** pack instead, add a JSON file
of `WorkflowDef[]` under `resources/workflows/` — `WorkflowStore.list()` reads every
`*.json` file there and tags each entry `builtin: true` (read-only in the UI, not
user-deletable).

## Adding an AI provider

The transport is intentionally provider-agnostic on the wire (`AiChatRequest` /
`AiStreamEvent` in `src/shared/types.ts`); all provider-specific logic lives in
`src/main/aiProxy.ts`:

1. Add the new kind to `AiProviderKind` (`src/shared/types.ts`).
2. If the provider speaks the OpenAI Chat Completions API (most local/self-hosted
   servers do), it likely needs **zero new code** — route it through
   `chatOpenAiCompatible()` alongside `openai`/`ollama`/`openai-compat` and just handle
   its base-URL/auth-header conventions in the `if/else` at the top of that method.
3. If it has its own wire format (like Anthropic's `/v1/messages`), add a
   `chatMyProvider()` method that emits the same normalized `AiStreamEvent` union
   (`start` / `text` / `tool_use` / `done` / `error`) that `chatAnthropic()` and
   `chatOpenAiCompatible()` already produce, and branch to it in `chat()`.
4. Add default model presets to `AI_MODEL_PRESETS` in `src/shared/defaults.ts` (or
   leave it an empty array if the provider has no fixed model list, like Ollama).
5. Wire the API key path in `SettingsStore.setSecret`/`getSecret` if the provider
   needs one — it already handles arbitrary `AiProviderKind` values generically, so
   this is usually free.

## Tests

Unit tests (`vitest`) live in `tests/*.test.ts` for pure logic — see the existing
`ansi.test.ts`, `fuzzy.test.ts`, `mergeDeep.test.ts`, `termLinks.test.ts`, `uid.test.ts`
for the pattern (no DOM, no Electron — plain function-level tests against
`src/renderer/src/lib` and `src/main` helpers). There is currently no
integration/e2e harness; keep new logic testable at the function level where possible.

## Pull requests

Small, focused PRs. Run `npm run typecheck && npm test && npm run format` before
opening one. Describe *why* the change is needed, not just what changed.
