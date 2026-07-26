# Changelog

All notable changes to Zarya are documented here. This project uses
[Semantic Versioning](https://semver.org/).

## 0.5.2 — «Шлюз» (2026-07-26)

Продолжение «Часового»: разобраны MEDIUM-находки того же аудита. Гейт одобрения
больше не может ни соврать про режим, ни спрятать то, что просит одобрить; профиль
терминала не добавляется без явного согласия; сборочная цепочка обновлена. Иконка
приложения перестала мылиться на рабочем столе.

### Security

Продолжение разбора того же аудита — MEDIUM-находки про гейт одобрения.

- **«Автоподтверждение команд» больше не снимает гейт с правки файлов.** Настройка
  задумана для встроенного борта Зари и его единственного инструмента
  `run_command`, но передавалась и нативным драйверам как
  `permissionMode: 'acceptEdits'` — это собственный режим Claude Agent SDK
  «auto-accept file edit operations». Правки Write/Edit проходили **ниже**
  `canUseTool`, то есть мимо всей системы одобрения приложения, при этом
  «АВТОПИЛОТ» был выключен, а чип в баре уверял, что борт спрашивает. Теперь
  нативным драйверам всегда уходит `permissionMode: 'default'`; ослабить гейт
  можно ровно одним явным переключателем — «АВТОПИЛОТ»
  (`src/renderer/src/features/ai/aiStore.ts`, `src/shared/types.ts`).
- **Карточка одобрения больше не прячет то, что просит одобрить.** Длинная или
  многострочная команда сворачивалась до первых 88 символов первой строки —
  опасная часть (`&& rm -rf …`, вторая и третья строки) оставалась под
  сворачиванием, пока «ВЫПОЛНИТЬ» и Enter были в одно нажатие. Пока гейт ждёт
  решения, команда закреплена целиком в отдельном блоке: свернуть нельзя, обрезки
  нет, внутреннего скролла, прячущего хвост, — тоже, многострочность подписана
  счётчиком строк. Строке заголовка текст не доверяем: она делит одну строку с
  подписью инструмента и обрезается примерно на половине порога, так что решение
  «по длине» оставляло полосу команд, срезанных вёрсткой без возможности
  развернуть. Лента при этом прокручивается к ждущему гейту — Enter одобряет из
  любого места окна, поэтому карточка за краем экрана была бы тем же слепым «да».
  После решения карточка снова сворачивается: это уже история, а не выбор
  (`src/renderer/src/features/ai/gates.ts`,
  `src/renderer/src/components/MissionFeed.tsx`, `tests/gates.test.ts`).
- **Чип режима больше не молчит и не врёт.** В режиме встроенного борта чипа не
  было вовсе — включённое автоподтверждение выглядело неотличимо от ручного
  режима. У Gemini/Kimi/Qwen, наоборот, рисовался живой переключатель
  «АВТОПИЛОТ», который физически ничего не делал (`setBypass()` — заглушка, эти
  борта спрашивают всегда). Теперь чип есть во всех агентских режимах и
  показывает тот переключатель, который реально управляет активным бортом, а у
  бортов без bypass он заперт на «РУЧНОЙ». Пока возможности драйверов ещё не
  загрузились, чип показывает настройку, которая реально уйдёт в драйвер, а не
  «автопилот не поддерживается» (`src/renderer/src/components/AgentBar.tsx`,
  `src/main/acpDriver.ts`).
- **Песочница Codex больше не снимает гейт в обход «АВТОПИЛОТА».** Тред
  открывался с `sandbox: 'workspaceWrite'` намертво, а `on-request` в такой связке
  спрашивает только про то, что выходит ЗА песочницу: правку внутри открытой папки
  Codex одобрял сам, без запроса, без карточки и без следа в ленте, пока чип
  показывал «РУЧНОЙ». Теперь песочница следует тому же переключателю, что и
  политика одобрения; при расхождении с той, с которой открыт тред, уходит
  оверрайд на ход — иначе выключение автопилота посреди разговора оставляло тред
  писабельным. Оверрайд шлётся только при расхождении: он заменяет политику
  целиком, и на каждом ходу затирал бы пользовательский
  `[sandbox_workspace_write]` из `~/.codex/config.toml` (`src/main/codexDriver.ts`).
- **Карточка правки в Codex называет файлы.** Запрос на одобрение патча не несёт
  пути — они приходят отдельным событием, и карточка показывала безликое
  «Изменение файлов». После перевода песочницы в read-only через этот гейт пошли
  ВСЕ правки внутри проекта, так что правка `src/` стала неотличима от правки
  `~/.codex/config.toml` — а частый безымянный гейт как раз и вырабатывает слепое
  «Enter». Пути запоминаются из `item/started` и попадают в подпись; когда пути нет
  вовсе, карточка так и говорит, вместо уверенной константы
  (`src/main/codexDriver.ts`, `src/main/codexProtocol.ts`,
  `scripts/mock-codex-app-server.mjs`).
- **Лента ведёт к тому гейту, который одобрит Enter.** Прокрутка шла в конец
  ленты, а Enter одобряет ПЕРВЫЙ неулаженный гейт: при параллельных вызовах
  инструментов на экране оказывалась одна карточка, а подтверждалась другая.
  Теперь якорь — сама карточка, и подпись «Enter · Esc» стоит только на ней
  (`src/renderer/src/components/MissionFeed.tsx`,
  `src/renderer/src/features/ai/gates.ts`).
- **Гейты Gemini/Kimi/Qwen перестали быть безымянными.** Эти борта присылают
  человеческое описание только в `displayName`/`input.title`, а карточка в ленте
  собирала подпись без них — и показывала голое «Bash» или «Edit». То есть
  подтверждение команды, текста которой не было на экране вообще. Подпись теперь
  собирается из самого гейта, одинаково в ленте и в панели
  (`src/renderer/src/features/ai/gates.ts`,
  `src/renderer/src/components/MissionFeed.tsx`).
- **Профиль терминала больше не добавляется молча.** `terminal.customProfiles` —
  это список программ, которые приложение запускает, а канал настроек доступен
  из renderer: скомпрометированный renderer мог прописать свой бинарник и
  получить запуск при каждом старте, то есть **персистентность**, переживающую
  перезапуск. Теперь профиль проходит структурную проверку (абсолютный путь к
  существующему файлу, без управляющих символов, ограниченный argv), из
  окружения пропускаются только локаль, таймзона и прокси — по белому списку,
  потому что чёрный не замыкается: `PROMPT_COMMAND`, `PS0`, `BASH_FUNC_*`,
  `PSModulePath`, `HOME` дают исполнение, а наши же скрипты интеграции читают
  `$HOME/.bashrc`. Всё, что начнёт исполняться заново, дополнительно требует
  явного подтверждения с показом пути, аргументов и значений переменных; отказ
  оставляет прежний список. Профиль перепроверяется ещё раз в момент запуска —
  файл настроек правится и руками (`src/main/shellProfileGuard.ts`,
  `src/main/ipc.ts`, `tests/shellProfileGuard.test.ts`).
- **Найденные шеллы резолвятся в абсолютный путь.** WSL-профили держали голое
  `wsl.exe`, а на Windows загрузчик ищет программу сначала в рабочем каталоге
  дочернего процесса — та же ловушка порядка поиска, что уже закрыта для git.
  Заодно найденные профили теперь имеют приоритет над пользовательскими: профиль
  с чужим id (`pwsh`, `cmd`) больше не подменяет системный шелл, на который
  указывает «авто» (`src/main/shellProfiles.ts`).

### Changed

- **Сборочная цепочка обновлена: electron-builder 24.13.3 → 26.15.3.** Все
  `app-builder-lib < 26.15.0` генерируют AppRun с висящим двоеточием в
  `LD_LIBRARY_PATH` (GHSA-7g7r-gx96-252g), а линковщик трактует его как текущий
  каталог — дефект уходил в поставляемый AppImage. Апгрейд закрывает и всю
  dev-цепочку: `critical` в `npm audit` больше нет (было 1), `high` — 16 вместо
  22. Требует Node ≥ 20.19 (26.x читает ESM-зависимость через `require`),
  поэтому в `engines` зафиксирована нижняя граница.

### Fixed

- **Гейт на правку файла в боковой панели больше не пустой.** Панель «IDE-агент»
  подписывала карточку только из `input.command`, поэтому запрос Edit/Write/Read
  показывался как «—»: подтверждение без единого слова о том, что подтверждаешь.
  Подпись теперь общая с главной лентой, и многострочная команда сохраняет
  переводы строк (`src/renderer/src/features/ai/AiPanel.tsx`,
  `src/renderer/src/features/ai/gates.ts`).
- **Иконка на рабочем столе больше не мылится.** Заря рисуется нативно на каждом
  размере, но собранный `.ico` держал всего четыре записи (16/32/48/256), и его
  48px был даунскейлом с 256 — а рабочий стол берёт ровно 48px. На «крупные
  значки» (96px) такого размера не было вовсе: система брала 48 и растягивала.
  Теперь в `.ico` десять нативных размеров (16, 20, 24, 32, 40, 48, 64, 96, 128,
  256), а генератор переписан на Node без Aseprite и без новых зависимостей — он
  сверяется с закоммиченными PNG и отказывается работать при расхождении, так что
  рисунок гарантированно тот же (`scripts/gen-zarya-icon.mjs`, `build/icon.ico`).

## 0.5.1 — «Часовой» (2026-07-25)

A security + freshness release. An adversarial audit of the whole attack surface
(process spawning, the Electron/IPC boundary, approval gates, secrets, supply
chain) turned up four ways untrusted content could act with the app's authority
— all closed here. Separately, newly released Claude models now appear on their
own, without rebuilding or restarting Zarya.

### Security

Found by an adversarial audit of the whole attack surface (process spawning,
Electron/IPC boundary, approval gates, secrets, supply chain).

- **Опасная папка больше не выполняет код просто от того, что её открыли.**
  `git` запускался по голому имени, а рабочим каталогом был любой каталог,
  который пользователь открыл. На Windows libuv резолвит имя программы из cwd
  дочернего процесса **раньше PATH**, поэтому `git.exe`, положенный в репозиторий,
  zip или расшаренную папку, выполнялся в main-процессе — без гейта одобрения и
  без следа в интерфейсе, автоматически при первом же опросе git-панели.
  Воспроизведено экспериментально; `NoDefaultCurrentDirectoryInExePath` не
  спасает. Теперь путь к git резолвится один раз из доверенных мест, а если
  доверенный git не найден — git-функции просто выключаются, без отката на
  голое имя (`src/main/gitService.ts`, `tests/gitExe.test.ts`).
- **Ссылка в ответе агента больше не может увести окно на произвольный `file://`.**
  Навигационный гейт считал своим origin любой `file:` URL, а лента ответов не
  перехватывала клики по ссылкам — относительная ссылка в markdown резолвилась
  относительно нашего же документа и загружала подсунутую локальную страницу с
  полным доступом к preload-API (pty.write, файлы, управление агентом), то есть
  RCE в обход всех гейтов. Теперь разрешён ровно наш документ, а ссылки из ленты
  уходят во внешний браузер (`src/main/index.ts`,
  `src/renderer/src/components/MissionFeed.tsx`).
- **Гейт одобрения больше не бывает невидимым.** Карточка с командой рисовалась
  только из блоков `tool_use`, которые шлёт один Claude Code. У Codex, Gemini,
  Kimi и Qwen запрос прилетал голым событием — карточки не было **нигде**, но
  Enter его исправно одобрял. То есть пользователь подтверждал команду, которую
  не видел. Теперь любой запрос без описания получает свою карточку в ленте и в
  панели (`src/renderer/src/features/ai/gates.ts`).
- **Рабочий каталог сессии больше не подделывается выводом терминала.** Каталог
  отслеживался по OSC 7 / 9;9 / 1337 / 633;P — а это обычный вывод, который
  может напечатать любая программа. Каталог при этом становится рабочим
  каталогом агента и корнем, которым ограничен его доступ к файлам, так что
  подделка молча расширяла песочницу. Интеграция оболочки теперь сообщает
  каталог по приватному каналу с посессионным nonce (в дочерние процессы он не
  попадает), и после первого доверенного сообщения все неподписанные
  игнорируются. Оболочки без интеграции (cmd.exe, свои профили) работают как
  раньше — защита включается сама, без настроек
  (`src/renderer/src/terminal/cwdTrust.ts`).
- **Dev-сервер сверяется по origin, а не по префиксу строки** — префиксная
  проверка принимала `http://localhost:5920@evil.com/` за свой origin.

### Fixed

- **New Claude models no longer stay invisible.** The model catalog is served by
  the `claude` binary, not by Zarya — so a model released after the build (Opus 5)
  never appeared in the launch console. Three causes, all fixed: the catalog was
  only re-fetched when the cached list was *empty*, `listModels()` returned nothing
  without a live session, and the shipped binary lagged the user's own CLI
  (`src/main/claudeCodeDriver.ts`, `src/renderer/src/components/LaunchPad.tsx`).
- **Fallback model list no longer claims a stale version.** The emergency catalog
  pinned `claude-opus-4-8`, so offline it announced "Opus 4.8" while the CLI would
  actually run Opus 5. Floating aliases are now version-free; the live catalog
  supplies the exact version.
- **Model identity is version-aware.** `sameModel` compared families only, so
  `claude-opus-4-8[1m]` and `claude-opus-5[1m]` were "the same model": a pin left
  over from a previous generation lit up the NEW row while the OLD id was still
  what got launched. Versions (and the 1M variant) must now agree; a pin no
  longer in the catalog surfaces as its own row instead of silently borrowing
  someone else's (`src/renderer/src/features/ai/modelMatch.ts`).
- **Unpinned model now highlights its row.** The resolve ran over the raw
  catalog, where the account `default` entry (a pointer at another model) is
  matched first and then filtered out of the rendered list — so with no explicit
  pin *no* row was marked active even though a model was plainly running.
- **A model picked while another tab was focused now reaches a running session.**
  Follow-up turns re-synced only bypass and dropped `model`/`effort`/`ultracode`,
  so a background session kept its start-time model for the rest of its life.
- **A hung CLI can no longer freeze the catalog until restart.** The session-less
  probe had no deadline: an unresponsive child left the promise pending forever,
  leaking the process and latching the in-flight guards (catalog and fuel poll
  dead until the app restarted). It now races a 20s timeout and always settles.

### Added

- **Newest-binary preference** — Zarya now runs the user's own (self-updating)
  `claude` CLI when it is strictly newer than the bundled one on the same major
  version, so newly released models appear **without rebuilding or restarting**
  the app. Guard rails: never downgrades, never crosses a major version, and
  `ZARYA_CLAUDE_BIN` overrides everything (`src/main/claudeExe.ts`).
- **Session-less catalog + usage fetch** — a throwaway idle query backs both the
  model catalog and the fuel gauge, so both are correct before the first prompt.
- **QA:** `npm run qa:models` — proves the console shows a *dynamic* catalog with
  no live session, and reports whether the bundled binary has fallen behind the
  system one (`scripts/qa-claude-catalog.mjs`, `scripts/qa-model-refresh.mjs`).
  Unit coverage for the binary-choice policy and the terminal-settings mapping
  (`tests/claudeExe.test.ts`, `tests/terminalOptions.test.ts`) — 109 tests.

### Changed

- Bundled Claude Agent SDK `0.3.217` → `0.3.220` (ships CLI 2.1.220, which knows
  Opus 5).

## 0.5.0 — «Созвездие» (2026-07-24)

A multi-agent release. Zarya is no longer tied to a single AI backend: a driver
abstraction now lets **five native agent engines** live side by side —
Claude Code, **Codex**, **Gemini**, **Kimi** and **Qwen** — each a chip in the
command bar, each with its own tool-approval gates and resume. Plus bring-your-own-key
presets for Kimi/Qwen/DeepSeek and macOS packaging.

### Added

- **AgentDriver abstraction** — the AI layer is generalized from a hardcoded
  `engine === 'claude-code'` into an open `AgentDriver` interface + capability
  flags + a driver registry, with generic `agent:*` IPC. The renderer renders
  controls from each engine's declared capabilities (fuel gauge, effort dial,
  model picker, bypass, question widget), so a new engine lights up the right UI
  without touching the renderer (`src/main/agentDriver.ts`, `src/shared/types.ts`).
- **Codex engine** — native driver over `codex app-server` (JSON-RPC/JSONL on
  stdio): threads, streamed turns, live command/patch **approval gates**, resume,
  interrupt, model catalog (`src/main/codexDriver.ts`). Appears as a chip when the
  `codex` CLI is installed.
- **Gemini engine (ACP)** — native driver over `gemini --acp` (Agent Client
  Protocol): sessions, streamed chunks, a single unified permission gate, resume,
  interrupt, and a **filesystem proxy confined to the session's working directory**
  (`src/main/acpDriver.ts`).
- **Kimi + Qwen engines** — the same parameterized ACP driver also backs
  `kimi acp` and `qwen --acp`, so both Chinese frontier coding models run natively
  with zero extra transport code. (Qwen's ACP is upstream-experimental.)
- **Bring-your-own-key presets** — the OpenAI-compatible provider gains one-click
  baseURL presets for **Kimi (Moonshot)**, **Qwen (DashScope)** and **DeepSeek** in
  Settings → AI; model ids are typed in (they rotate often). See `docs/ai.md`.
- **macOS packaging** — the Claude Code SDK's platform CLI is unpacked for every
  platform (win/mac-arm/mac-x64/linux), so builds run outside the asar on macOS.

### Security

- **fs-proxy confinement (ACP)** — agent-driven file reads/writes are restricted
  to the session working directory both lexically **and** after resolving symlinks
  (a junction/symlink inside cwd can't escape); untrusted paths that aren't strings
  can't crash the main process.
- **Hardened stdio transports** — bounded JSONL decoder (a runaway line can't OOM
  main), fail-closed tool approvals, request timeouts, and clean teardown of child
  processes on every quit path, across the Codex and ACP drivers.

### Tested

- 80 unit tests + offscreen harnesses covering each driver end-to-end against a
  protocol-accurate mock server (init, streaming, approve/deny, resume, interrupt,
  fs-proxy + traversal, crash/recovery, quit teardown). Every increment was
  reviewed adversarially before landing.

## 0.4.0 — «Орбита» (2026-07-21)

A large "cosmic CLI agent" redesign — Soviet-space pixel-constructivism. The whole
shell now reads like a launch console: pixel type, a drifting starfield, a launch
pad for the AI engine, and a bilingual "mission control" settings surface.

### Added

- **Pixel type system** — bundled offline pixel/dot-matrix fonts alongside the
  existing constructivist voice: **Pixelify Sans** (logo, hero headings) and
  **Handjet** (tech labels, bilingual sub-labels, telemetry gauges), plus PT Sans /
  JetBrains Mono for body and terminal (Oswald + Ruslan Display retained). All
  Cyrillic + Latin subsets, no network fetch (`src/renderer/src/main.tsx`).
- **Star backdrop** — a pixelated, twinkling starfield with occasional shooting
  stars sitting behind the whole app (`StarBackdrop.tsx`); pointer-events-none,
  DPR-capped, theme-aware (dark stars on light "poster" themes), and paused under
  `prefers-reduced-motion`.
- **Pixel logo** — "ЗАРЯ // ОРБИТА-1" wordmark in the titlebar (`Titlebar.tsx`).
- **Launch Pad ("Пусковой комплекс")** — a rocket-console overlay for picking the
  AI **engine (model)** and **thrust (effort)**, with a live mission clock and a
  pixel launch-pad scene; **ПУСК · ПОЕХАЛИ** applies both to settings and fires the
  launch animation (`LaunchPad.tsx`). Opened via `Ctrl+Alt+M` (`app.launch-pad`),
  the command palette, or a button in Settings → AI.
- **Reasoning thrust ("тяга")** — a new `AiSettings.effort` (`AiEffort`:
  `low` / `medium` / `high` / `max`) that drives temperature **and** token budget
  through `EFFORT_TUNING` (`src/shared/defaults.ts`). Surfaced as a 4-segment
  thrust bar in both the Launch Pad and Settings → AI.
- **Rocket-launch overlay** — a cinematic "ПОЕХАЛИ!" liftoff (countdown, parallax
  star streaks, exhaust embers, screen shake) fired on engine/thrust and
  provider/model changes (`RocketLaunch.tsx`).
- **"Центр управления" (Mission Control) settings** — the settings view is
  restyled as a control room with bilingual RU + EN labels, a 2-column theme-card
  picker, a gold −/+ font-size stepper, and a dedicated "rocket" toggle reserved for
  the dangerous auto-approve switch (`SettingsView.tsx`).
- **Expanded theme collection** — 9 cosmic-constructivist themes replacing the
  original two: 6 dark (**Заря · Космос** default, **Восток**, **Орбита**,
  **Спутник**, **Байконур**, **Рассвет**) and 3 light "poster paper" themes
  (**Плакат**, **Полдень**, **Чертёж**). See [docs/themes.md](docs/themes.md).
- **Terminal instrument-panel header** — a thin per-pane strip above each xterm
  surface ("★ CLI-АГЕНТ · ЗАРЯ" + the pane's own cwd) (`TerminalPane.tsx`).
- **"Топливо" fuel strip** — a launch-themed status line in the AI panel
  (`AiPanel.tsx`) and a matching fuel status item in the bottom status bar.
- **Offscreen QA harness** — `scripts/shoot.mjs`, a coverage-independent visual-QA
  tool that boots Zarya in an isolated throwaway instance (Playwright's Electron
  driver, its own `userData`, no single-instance lock, no user sessions) and
  captures the renderer's real pixels regardless of what covers the window or which
  monitor it's on. Supports `--theme`, `--rocket`, `--ui`, `--out`, `--wait`.

### Changed

- **Default theme** is now `zarya-cosmos` (Заря · Космос).
- **Exit-code badges, block separators and command blocks** restyled to match the
  new console aesthetic (behaviour unchanged).
- **Prepare-quit safety timer** raised from 2s to **8s** so session
  snapshot/prune has realistic room to finish on quit instead of being cut off
  mid-write (`src/main/index.ts`).

### Security

- **Prompt-injection spotlighting (OWASP LLM01)** — recent terminal output attached
  as automatic AI context is now wrapped in explicit `<untrusted-terminal-output>`
  markers in the system prompt, with an instruction to treat it strictly as data and
  never as instructions; a payload that forges the closing marker is neutralized
  (`src/renderer/src/features/ai/aiStore.ts`).
- **Navigation hardening** — `will-navigate` **and** `will-redirect` on the main
  window are now guarded: any off-origin navigation of the top frame is blocked and
  `http(s)` URLs are routed to the system browser instead, so the `window.zarya`
  bridge can never be exposed to a remote page (`src/main/index.ts`).
- **Isolated-instance override** — `ZARYA_USER_DATA` points a throwaway instance
  (used by the QA harness) at its own `userData` and bypasses the single-instance
  lock, so visual QA never touches the user's real sessions or settings.

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
