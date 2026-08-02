# Changelog

All notable changes to Zarya are documented here. This project uses
[Semantic Versioning](https://semver.org/).

Русская версия этого файла — [CHANGELOG.ru.md](CHANGELOG.ru.md).

## 0.7.2 — "Callsign" (2026-08-02)

### Added

- **Your own speech model, from disk.** The built-in list is closed on purpose:
  a downloaded file goes straight into a native engine, so a "paste a link"
  field would be a way to run someone else's code. The consequence was
  inconvenient, though — a multilingual Whisper meant waiting for a Zarya
  release.

  Now you can point Zarya at a folder you already have. **Settings → Voice →
  Choose folder…**: it recognises what is inside (whisper, transducer, moonshine,
  nemo-ctc, sense-voice, paraformer, zipformer, dolphin, canary, fire-red),
  shows it in the same list marked *yours*, and dictates with it like with any
  other model. Nothing is copied — the files stay where they are.

  What it refuses to do is guess. A lone `model.onnx` in a folder with an
  uninformative name looks identical for six different families; guessing would
  build an engine that produces garbage and blame "a bad model". Instead you get
  a refusal that says what to do: put a `zarya-model.json` next to the files —
  and there is a button that copies a sample.

  The path only ever comes from the system dialog opened by the main process:
  the channel accepts the command "ask the human", not a ready path. And
  "Remove" removes the entry, never the files — Zarya did not put them there.

- **The model catalogue comes from the provider, live.** The launch pad used to
  list models from a constant in the source — so it aged with every Anthropic
  release, silently, and showed no Opus 5 to someone working on a Claude
  subscription. Zarya now asks the provider itself (`GET /v1/models` for
  Anthropic and OpenAI, `/api/tags` for Ollama) and caches the answer: the
  screen opens instantly from cache and the live reply refreshes it. The request
  is made by the main process, which holds the key; the base URL comes from
  settings, never from the window. Without a key you get an honest error and an
  empty list rather than an invented one.

- **A new model announces itself once.** When an id appears that was not there
  before, a small strip says so. The comparison is against what you have *seen*,
  not against the previous reply — otherwise a minute of bad network would
  announce yesterday's models as news. The first catalogue is remembered
  silently, so a fresh install does not greet you with a notice per model.

- **The look moves from the space programme to the dawn the app is named after.**
  Zarya means daybreak, and daybreak gives what an era cannot: light with a
  direction and a time of day. Two new themes lead it — **Blue Hour** (twenty
  minutes before sunrise; the one warm thing in the window is the amber that
  means "Enter lands here") and **Golden Hour** (morning on paper, for working in
  a lit room). Blue Hour is the new default.

  The starfield and the constructivist grid are gone. In their place the window
  simply has a bottom: a barely-there rise in light where the input line lives —
  the place you act from.

  Themes keep their palettes and lose the launch-site names: Kosmos → Night,
  Vostok → Embers, Orbit → Frost, Sputnik → Ash, Baikonur → Sand, Poster →
  Paper, Blueprint → Tracing. Nobody loses the theme they picked.

  Words follow: "LAUNCH PAD" → "MODEL & EFFORT", "LAUNCH · POYEKHALI" → "APPLY",
  "MISSION CONTROL" → "SETTINGS", "Crew · agents" → "Agents", "Ready for launch"
  → "Ready when you are". The tagline becomes **// FIRST LIGHT** — in astronomy
  that is an instrument's first working night, which is exactly what this is.

  And the provider call signs go: ANT-1 / GPT-2 / LUNA are now Anthropic /
  OpenAI / Ollama. That one is not taste — a call sign hides *who* your prompt
  goes to.

- **Sidebar sections fold.** "Recent" is a list nobody curates: it grows on its
  own and by the end of a week it buries the open terminals and busy agents the
  sidebar exists for. Every section now folds from its own heading, remembers
  that between launches, and shows a count while folded so it never reads as
  empty. Recent starts folded; searching unfolds it automatically.

### Changed

- **Effort is called what the CLI calls it.** "ТЯГА · EFFORT" with steps
  МАЛАЯ / СРЕДНЯЯ / ВЫСОКАЯ / СВЕРХ / ФОРСАЖ read nicely, but it was our
  metaphor laid over someone else's concept: in Claude Code and its docs this is
  `effort` with low / medium / high / xhigh / max. Anyone checking the
  documentation had to carry a translation in their head. The steps are now
  **LOW · MEDIUM · HIGH · XHIGH · MAX** in both languages, like a model name,
  and the heading is simply EFFORT. The "faster" / "smarter" captions stay —
  they explain the direction rather than translate the term.

- **"Open folder…" became "Add project…".** The item sits first in the projects
  list, and after it the folder appears in that same list — the old name
  described half the action and left the new row unexplained.

- **Inactive panes are no longer dimmed.** On a light theme the dimming
  (brightness 0.66 plus opacity 0.62) turned white into dirty grey: three panes
  out of four looked switched off while work was running in them. The accent
  border already answers the only question dimming was meant to answer — where
  Enter will go.

### Fixed

- **A wrongly identified speech model can no longer take the app down with it.**
  The engine does not return an error when handed an ONNX of the wrong shape — the
  native library prints a line and calls `exit(-1)` from a worker thread. In the
  main process that means Zarya vanishes: panes, terminals, agents and unsaved
  state, without a word about why. And since the choice stayed in settings, the
  next launch died the same way.

  A custom model is now started in a **separate process first**. If it does not
  build, you get the engine's own words — the missing metadata usually names the
  real family — and nothing is added. Verified on real weights: Whisper tiny
  declared as `senseVoice` is refused in words, and the window stays up.

- **Folder recognition matches the real repositories.** Canonical sherpa-onnx
  folders ship two editions of the same file (`model.onnx` and
  `model.int8.onnx`); the rule "exactly one .onnx" rejected them — including the
  multilingual sense-voice this feature exists for. And `ctc` in a folder name no
  longer counts as NeMo: `telespeech-ctc` is a different family the addon cannot
  build at all, so guessing meant crashing, not degrading.

- **`Enter` in a dialog no longer approves a tool behind it.** With a gate waiting
  in the active pane, opening the rename dialog and pressing `Enter` on its
  button did two things: saved the name *and* approved the command you had not
  read yet. The dialog now owns `Enter` and `Esc` while it is open.

- **The model catalogue no longer outlives its provider.** Switching the provider
  chip kept the previous list on screen (Claude models offered as OpenAI's), and a
  refusal from the provider fell back to the hardcoded preset — the very stale
  list the live catalogue replaced. Both now clear, and a refusal says so.

- **`qa:models` ran only a third of what it claimed.** A duplicate key in
  `package.json` silently shadowed two runs (`qa-claude-catalog`,
  `qa-model-refresh`); JSON keeps the last one. Restored, and `qa:fake-agents`
  now builds first like every other run.

Smaller ones from the same review: a missing `common.close` key showed the raw
key in a tooltip; the "new model" strip sat below the launch pad's click
catcher; the seen-models list could evict a model that was still in the
catalogue and announce it as new twice; a model folder in a drive root had no
name; a manifest was found case-insensitively but read in lowercase (Linux); the
file list was capped before the manifest was looked for.


- **Renaming works again.** Clicking the pencil on a desk did *nothing*:
  Electron does not implement `window.prompt`, and seven places in the interface
  rested on it — renaming a desk (button and double click), a pane, a saved
  session, creating a file or a folder, renaming a file in the tree. All of them
  silently did nothing, which is the worst kind of untruth an interface can
  tell: not an error, silence. They now use Zarya's own dialog — the same
  promise, kept.

- **The pane's mode survives a restart.** It lived only in window memory: you
  worked in Claude Code, restarted, and found yourself in a plain shell without
  choosing anything. It is stored in the session snapshot now and comes back
  with it.

- **The launch pad opens on the branch of the pane you are looking at.** It read
  the window-wide default instead of the pane's own mode, so after a restart you
  could have Claude Code running in the pane — input line and all — while the
  console offered the built-in agent's accounts and model list. Pressing "ПУСК"
  there would have applied the choice somewhere other than where you were looking.

- **A pane keeps the engine it was born with.** Until a pane had its own record
  it followed the window-wide default — which any *other* pane's switch changes.
  Switching one pane to Codex silently moved every pane you had not touched.
  A new pane still starts as "the same as the last one", but from then on it is
  its own CLI: Claude Code in one pane and Codex in the next stay put.

### Tested

- 431 unit tests; live runs: panes 140, launch pad 41, catalogue 10, progress
  16, language 10, agent engines 21, speech models 16 + 22, key routing 6,
  projects 6.
- Six live-app runs execute in CI under xvfb on every push — the custom speech
  model and the key router joined them.
- The custom-model path was also verified on real weights (`npm run
  qa:voice-custom`): Whisper tiny is added, recognises, and the same weights
  declared as another family are refused in words with the window still up.

## 0.7.1 — "Countdown" (2026-07-31)

### Added

- **You can see that work is happening.** An agent would go off to clone a
  repository and the screen fell silent: the tool card showed a spinner and the
  word "running" — no seconds, no line of output. Whether it had been a minute or
  ten was impossible to tell.

  The card now ticks: **running · 1:24**. It works for every engine, Claude Code
  included, because the start time is the one thing we honestly know — the SDK
  hands over a tool's output in a single piece at the end, and there is no
  intermediate progress in it at all (`include_partial_messages` streams the
  answer text and the thinking, not the tool output). The clock starts at
  **approval**, not when the gate appears: while a card waits for your decision,
  the time is yours, not the command's.

- **A download line for commands that run in your terminal.** Downloaders
  (`git clone`, `pip`, `wget`, `docker pull`) write progress as one line they
  keep redrawing; in a terminal that reads fine, in the feed it turned into
  jumping digits. The percentage, the size, the speed and the ETA are now pulled
  out of the output and shown as a bar that stays in one place.

  The parsing is deliberately picky: a percentage alone is not enough — it takes
  a second sign (speed, size, a bar, or the name of the work), otherwise a
  coverage report reading `Statements: 100% (42/42)` would draw a bar over
  nothing. With no percentage the width is not invented: a shuttle runs instead,
  because a bar sitting "about a third of the way" would promise knowledge we do
  not have.

### Changed

- **Projects live in one place.** The projects menu existed twice — in the header
  and under the sidebar caret — and both showed the same thing, the sidebar one
  with fewer actions. Inside each, the duplication continued: "Projects", "Add a
  folder to projects…" and "Recent folders" were three blocks about one thing.
  The separate "Add a folder to projects…" opened the SAME system folder picker
  as "Open folder…" and differed only in not opening the folder.

  Now the roles are split: the sidebar caret is about starting a terminal (three
  entries, no lists); the header "Projects" is the only place folders live. Open
  a folder and it lands in the list, freshest first; one button opens it as a
  pane, the cross removes it. The cap is 12 — with three to eight projects in
  play the eviction never fires, but a list without a limit stops being a list.

### Fixed

- **A tool card no longer vanishes the moment you approve it.** With engines that
  send no `tool_use` (Codex, Gemini, Kimi, Qwen) the gate was filtered out as
  settled, so pressing RUN left nothing on screen: the command ran for a minute
  and the feed said nothing. The card now lives until the result arrives, and the
  "the agent wants to run" label is dropped once the decision is made — it was
  announcing a choice that no longer existed.
- **The "open now" dot stopped lying.** Paths were compared character by
  character, and the same folder arrives in different shapes: the picker gives a
  backslash path, the shell reports a forward-slash one. Comparison is now by
  meaning, with the platform in mind: case is ignored only for paths with a drive
  letter, because on Linux `~/Code` and `~/code` are different folders.
- **An empty output snapshot no longer wipes what is already on screen** — the
  feed used to flash blank while a command was still running.

### Tested

- `npm run qa:progress` — 16 live checks: the bar, its updates, the shuttle with
  no percentage, silence on ordinary output, the ticking clock, the card after
  approval. Plus 15 unit tests on the progress parsing and 9 on the project list
  (order, cap, path comparison).

## 0.7.0 — "Lexicon" (2026-07-31)

### Added

- **Zarya speaks English.** The whole interface exists in two languages now —
  English and Russian — and switching between them is instant: both dictionaries
  ship inside the app, so there is no second installer, no restart and no
  re-login. On first launch Zarya follows your system language; Settings →
  Appearance → Language pins it either way.

  Translated, not stripped: the Soviet space-age framing survives the crossing.
  Mission Control, the launch pad, thrust levels (LOW → AFTERBURNER), the ORBIT-1
  tagline and the ship themes (Kosmos, Vostok, Baikonur, Blueprint) all read as
  themselves in English rather than as a literal gloss.

  The agent follows the interface: with English selected, the built-in assistant
  is told to answer in English. So do the main-process texts — the terminal
  profile dialog, update errors, driver hints — because a native dialog in the
  wrong language is exactly where a person stops reading.

  A pane that was never renamed no longer carries a hard-coded Russian name: the
  default title is drawn from the language, and old saved sessions are migrated
  in place.

### Tested

- `node scripts/i18n-test.mjs` — walks the header, sidebar, feed, input line,
  pane menu, project menu, Mission Control and the launch pad in English and
  fails on any Cyrillic left in the interface (terminal output, agent answers and
  paths excluded — those are your data, not our labels). It also checks that both
  dictionaries are complete and that Russian is untouched: 10 checks.

### Fixed

- **The update page test no longer depends on the network.** It set a release
  state by hand while the real GitHub check arrived on top of it and blanked the
  screen under test. Runs now start with `ZARYA_NO_UPDATE_CHECK`.

## 0.6.5 — "Pad" (2026-07-31)

### Changed

- **Projects in the header make sense now.** Every project took TWO rows — the
  project itself plus an "as a pane" line, because the menu has no submenus, so
  the extra line read as a separate, meaningless entry (and its arrow indent
  collapsed into junk like "Ⴑ,"). Two projects meant four rows, and which
  belonged to what was unreadable.

  One row per project now: click opens it in a tab, the button next to it opens
  it as a pane, the cross removes it from the list, and dragging a project onto
  the pane you want still works. Projects that are already open carry a dot — the
  folder list now also says what is happening right now.

## 0.6.4 — "Slider" (2026-07-31)

### Fixed

- **The pane divider drags without stutter.** Resizing live cost 25.8 ms per
  mouse move — a frame and a half, which is exactly what the stutter was. Every
  move went down to the shell (`pty.resize` is ConPTY in the main process, four
  times a frame), updated the layout more often than the screen can paint, and
  made the feed re-lay itself in full.

  The shell is now told one size — the one you released on; the layout moves once
  per frame; the feed does not compute geometry for what is not visible. Divider
  drag: 25.8 → 7.6 ms.

## 0.6.3 — "Turn" (2026-07-31)

### Fixed

- **Working in three or four panes stopped lagging.** Two bottlenecks, both
  visible in numbers (`npm run perf` seeds a working day: four panes, fifty
  blocks each, 25-turn conversations).

  First: answer markup was re-parsed on EVERY render — and a render is called by
  a mouse move during a drag and by every chunk of the agent's answer. A finished
  message is now parsed once.

  Second: no feed component skipped other people's renders, and the conversation
  itself came down as a prop — so every stream chunk rebuilt the entire feed, with
  all its blocks, output lines and tool cards. Each card also looked up its result
  by scanning the whole conversation: the longer the talk, the slower it got.

  Mouse move while dragging: 19.6 → 6.9 ms. Agent answer chunk: 19.9 → 7.3 ms.
  A keystroke in the input line: 9.1 → 6.7 ms.

## 0.6.2 — "Edge" (2026-07-31)

### Added

- **You can see which edge a pane will land on.** While the side was never asked,
  everything landed on the right: you aimed at a pane's left edge and got the
  carried pane somewhere else. Dragging now highlights the HALF of the pane the
  carried one will take — by the nearest edge — and that is where it lands. Works
  for panes and for projects dragged from the header; top and bottom split the
  pane horizontally.

### Fixed

- **Three panes stopped being lopsided.** Moving a pane split the target in half,
  so a three-pane layout came out 50/25/25 while the rule promises equal thirds.
  The rule now applies to moves as well — as long as the layout was never dragged
  by hand. The other half of the same bug was fixed separately: for a move INSIDE
  a tab, "was the layout touched by hand" was evaluated against the already
  stripped tree, so the answer was always "yes".

## 0.6.1 — "Dock" (2026-07-31)

### Changed

- **You can see where to drag a pane.** The zone that returns a pane from the
  grid back to the list only lit up under the cursor — so it had to be guessed
  first. The dock now appears in the list from the very first movement, dashed and
  labelled: "return to the list — the pane leaves the grid as its own tab, the
  process keeps running". It only shows when there is something to detach: for a
  lone pane in its own tab the gesture would do nothing.

  The pane header also stopped being a mute handle: hovering brings out grip dots,
  the sign people actually look for before dragging.

## 0.6.0 — "Grid" (2026-07-31)

### Added

- **Every pane is a CLI of its own.** The window used to split in two, but the
  conversation, the input line, the feed and the mode were shared: two panes showed
  one talk, and a single Enter could approve a command in more than one of them.
  Now a pane has its own feed, its own input line, its own mode and its own
  autopilot, and keys are handed out by one dispatcher — to exactly one addressee.
  The focused pane is outlined, and that outline means literally one thing: Enter
  and Esc go here.

  The layout follows the pane count: one fills the screen, two or three are
  columns, four make a 2×2 grid. A fifth goes to a new tab — more than four in one
  tab turns the feed into five lines, and it would hit that limit silently.

- **The active tab's panes are rows in the sidebar.** "Open" used to list tabs:
  four panes were one row with a "· 4" suffix, and you could not click your way
  into a specific pane. The active tab is now expanded into panes, the rest are
  collapsed rows with a counter. Two degrees of highlight never get confused: "on
  screen" (the pane is visible) and "focused" (the pane gets Enter and Esc — there
  is exactly one, marked with the same accent as the outline on screen).

  Double-clicking a row maximizes the pane to the whole tab and back; its
  neighbours stay alive, just out of sight.

- **A pane can be moved and detached.** A pane is grabbed by its header: drop it
  on another pane to move it there, drop it in the list on the left to send it to
  its own desk. The process is not touched either way — removing a spare CLI from
  a split screen used to mean closing it, which means killing it.

- **A desk has a name.** The grouping was already the tab, but it was labelled
  with the name of whichever pane happened to be active in it: four different
  projects, one name, and a name that kept changing. It is now assembled from the
  panes ("Zarya + quiz-funnel +2") and renamed with a double click.

- **Images go to their own pane.** Ctrl+V and drag-and-drop put an image into the
  pane the cursor is in, show it as a chip before sending and downscale it to the
  model's limit. An engine that does not accept images says so out loud instead of
  swallowing the attachment.

### Fixed

- **A pane lost its screen when the layout was rebuilt.** A pane's place in the
  markup depended on its place in the tree: close one of four and a neighbour moved
  to a different level, and its terminal was created anew. Almost impossible to
  notice — the shell repaints the visible part — but the scrollback and the agent's
  output were gone. The tree now supplies coordinates only; a pane lives in a flat
  list keyed by its session and survives any rebuild, a move to another tab and
  maximizing.

- **A fifth pane went nowhere**: a live session was created with no slot in the
  tree — the terminal was running, absent from the list, and yet Enter and Esc
  were addressed to it.

- **Closing a pane neither asked nor cleaned up.** It now warns about what is
  about to be lost (an unsent prompt, a pending agent decision, a turn in flight),
  closes the gate and aborts the turn so the "waiting for a decision" counter does
  not stick forever, and cleans up after itself: attachments and the autopilot of a
  dead pane no longer come back when a session is restored.

- **Esc from someone else's input field interrupted the pane's work** — the one
  you dismiss the sidebar session search with, for instance.

- **The input mode and ↑ history were shared window-wide.** An agent that started
  a turn in a neighbouring pane flipped the chip here, and Enter sent a typed
  terminal command to the model. The up arrow fetched a command from another
  project and ran it in a different folder. Both now belong to the pane.

- **The microphone** is held by one lock per app: four panes no longer open four
  recordings of one phrase, and dictation goes to the pane the cursor is in.

## 0.5.8 — "Seal" (2026-07-29)

### Added

- **Signed releases.** One-click install now requires a signature: each release's
  checksum list is signed with an Ed25519 key that is not in CI — it lives on the
  maintainer's machine. The app verifies both things: the list's signature matches
  the built-in public key AND the sha256 of the downloaded file matches its line in
  that list. Mismatch — the file is deleted and the install is cancelled.

  Why: until now the whole chain rested on CI vouching for itself. `latest.yml` and
  `SHA256SUMS` are computed by the same machine that builds — with the pipeline
  compromised the hash would be valid, because it would be computed by the already
  substituted build. With auto-update that is silent code execution for everyone,
  without a single click.

  An unsigned release is not hidden: it is visible, it can be downloaded by hand,
  and the app says plainly why it will not install it itself. This is **not**
  Authenticode — SmartScreen will still warn on a manual install; what is closed is
  update substitution, not the Windows warning.

### Changed

- **Esc over a sent message removes it from the agent's memory too.** The message
  used to stay in the feed marked "interrupted", and the agent saw it on the next
  turn. It now disappears and returns to the input line — as in the real Claude
  Code.

  The mechanism comes from there as well: CLI transcripts are a tree, not a log,
  and cancelling continues the conversation from the PARENT of the cancelled entry.
  The Agent SDK gives exactly that (`resumeSessionAt` + `forkSession`): the next
  turn branches off the last agent answer, and the cancelled entry stays in the
  file as a dead branch.

  This works with Claude Code only. Codex and the ACP engines have no such
  mechanism — there the message still stays marked "interrupted", and that is
  honest: hiding what the agent remembers would be a lie.

### Fixed

- **An answer to a cancelled message no longer lands in the feed.** The
  interrupted session finished talking, and its answer appeared after the question
  was already gone.
- **A second Esc no longer marks an already answered turn as "interrupted".** The
  first was still in flight over IPC, the conversation looked idle for that
  instant, and the mark landed on the previous, honestly answered question.
- **The folder icon outline** in the left bar is two pixels, like its neighbours;
  it was visibly thinner than the rest.

## 0.5.7 — "Word" (2026-07-28)

### Added

- **Choice of speech model.** The model used to be one hard-coded constant — it is
  now a closed registry: **GigaAM v3** (Russian, 225 MB), **GigaAM v3 RNN-T**
  (Russian, 232 MB, better on long phrases) and **Moonshine tiny** (English,
  124 MB). All three MIT. Each can be downloaded, selected and deleted — three of
  them side by side weigh over half a gigabyte.

  Moonshine was picked for English not for accuracy: Whisper pads any input with
  zeros to 30 seconds, so a three-second phrase costs the same as a thirty-second
  one. Moonshine scales with length.

  The list stays **closed**: a configurable model URL would be a "download
  anything from anywhere" primitive, and what is downloaded is handed to a native
  engine.

### Fixed

- **Dictation now knows digits, Latin letters and punctuation.** The previous
  model's vocabulary was 34 tokens: a space and 33 lowercase Russian letters. No
  digits, no Latin, no capitals — dictating "git commit" or "cd 2" was physically
  impossible. The new one has 257 tokens. The old model keeps working: nothing is
  downloaded on its own, the upgrade is offered as a button.
- **Icons in the left bar are one size.** 16×16 glyphs stood next to 8×8 ones —
  "folder" and "update" were drawn at half the size of their neighbours.
- **Only the useful files on the update page.** The housekeeping `latest*.yml` and
  `.blockmap` files, which started shipping in 0.5.5, were listed alongside the
  builds: eleven rows where two are useful. Builds for other systems moved behind
  a fold.
- **Updating cleans up after itself.** Two copies of the installer stayed in the
  cache after installing — 382 MB, after every update. Cleaned at launch, and only
  what is older than the installed version: a downloaded but not yet installed
  update is left alone.

## 0.5.6 — "Step 2" (2026-07-28)

### Fixed

- **The portable build no longer offers to update itself.** electron-builder
  deliberately writes no update metadata for portable, and the installer would put
  a second, regular copy of the app next to it instead of updating the running
  file. The "can this build install an update" check answered "yes" for any Windows
  build — the button would have lied. Found by reconnaissance right after 0.5.5
  shipped.

## 0.5.5 — "Step" (2026-07-28)

### Added

- **One-click update.** "Updating" used to mean: open a browser, download 190 MB,
  check the hash by hand (nobody does), walk through the installer. Now there is an
  "Install the update" button, a download bar inside it and "Restart and install".
  Integrity is verified automatically against the sha512 from the release metadata.

  What is **not** done: downloading and installing in the background. `autoDownload`
  and `autoInstallOnAppQuit` are off explicitly — the difference between "I pressed
  a button" and "it swapped the executable while I was working" is fundamental, all
  the more so for an unsigned build.

  Installing goes through the regular exit: the renderer snapshots sessions,
  settings are flushed to disk, ptys and agents are shut down — and only then the
  installer starts. An update must not cost you your open terminals.

  Platforms are separated honestly: Windows — yes; Linux — AppImage only (`.deb` is
  the package manager's job); macOS — no, Squirrel.Mac requires signing and
  notarization. Where it cannot, there is no button, and the text explains why. The
  manual path with files and SHA256 is still there.

### Fixed

- **Releases contained no `latest.yml`.** The config had `publish: null`, so update
  metadata was not generated at all. It is now built and published together with
  the distributables, and publishing fails without it: a release with no metadata
  looks fine but silently breaks updating for everyone who already installed the
  app.
- **The update source is an explicit constant** (`setFeedURL`), redirects during a
  check are limited to a list of GitHub hosts, and the settings show the age of the
  last successful check — a silent proxy can answer "you are on the latest version"
  forever, and without a date that is indistinguishable from the truth.

## 0.5.4 — "Shutter" (2026-07-28)

A release about the interface not reassuring where there is nothing to reassure
with, and not losing what it shows.

### Fixed

- **A one-off "RUN" no longer becomes a standing permission.** Some ACP agents
  offer no one-off permission — only `allow_always`. The driver silently
  substituted it for an ordinary approval: the person meant one run, the agent got
  permission for the whole session and stopped asking. Neither the interface nor the
  reply said a word about it. Such a gate is now marked, the button says "ALLOW
  ALWAYS" and warns by colour, and a standing permission reaches the agent only with
  explicit consent. Denial is still escalated freely: "always deny" is stricter than
  a one-off.
- **The badge over an API key tells the truth.** It used to be one badge for every
  case — a green "Key saved" both over a key in the OS store and over a key sitting
  in `secrets.json` in plain text. There are three states now, explained right in
  the row. Protection is computed from two circumstances at once: how the key is
  written and what the system can do right now — on Linux without a keyring
  `encryptString` sets `enc:` while protecting nothing.
- **The dropdown fits in the window.** The session list (up to 25 rows with long
  titles) overflowed the edge — the TOP one at that: the position was clamped on one
  side only, and the top entries became unreachable. There is now a height ceiling
  with scrolling, clamping on both sides, one row per entry with the full text in a
  tooltip. The silent truncation of the list at 25 is now said out loud.
- **Pressing a button again closes the popup instead of blinking it.** The usage
  panel and the menu closed on `mousedown` while buttons toggled on `click`: the
  first event closed, the second immediately reopened.
- **Esc closes the menu even when focus is in the terminal.** xterm installs its
  handler in the capture phase and swallows Escape — the event never reached the
  menu listener.
- **Data file permissions narrowed to `0600`** (the directory to `0700`). `userData`
  holds provider keys, command history and conversations with the agent; Node created
  them with default permissions, which is 0644 on Linux. Files created by earlier
  versions are repaired separately: `history.jsonl` is append-only and never
  recreated by itself.

### Added

- **Command history under control.** The file grew without limit, recording could
  not be turned off and could not be erased — and commands regularly contain
  secrets. There is now a switch (effective immediately; with recording off the
  history is not read from disk at all), a "keep at most N" ceiling that compacts the
  file itself, and a clear button next to the line telling you how much has piled up.

## 0.5.3 — "Beacon" (2026-07-27)

### Added

- **Microphone selection for dictation.** Right-click the microphone button or
  Settings → Voice. Not only the `deviceId` is stored but the device name as well:
  Chromium salts identifiers per profile, and after they change the choice is
  repaired by name silently — but only on exactly one match, because two identical
  headsets is already guesswork. Windows pseudo-devices (`default`,
  `communications`) are filtered out, otherwise one microphone would appear three
  times. A missing device is visible everywhere: a "not found" row in settings and
  in the menu, a note in the button tooltip and a one-off message
  (`src/renderer/src/features/voice/devices.ts`).
- **Update check and a "What's new" page.** One anonymous request to GitHub at
  launch — no token, no identifiers, with a timeout. If something newer exists, a
  button with a dot appears in the bar, and behind it a page of its own: the version
  step, the changelog from the release body, files with sizes and SHA256 under each.
  The app downloads and starts nothing on its own: the builds are unsigned, and
  quietly slipping in an unsigned installer would be worse than letting you download
  it knowingly (`src/main/updateService.ts`, `src/renderer/src/features/updates/`).
- **Subagent wave in the feed.** Instead of a stack of identical "subagent
  working…" lines — one line, "3/3 agents · 32s · ↓103.8K tokens", plus a line per
  live task with the tool it is on. Every number is Claude Code's own telemetry,
  nothing invented (`src/renderer/src/features/ai/subagents.ts`).

### Changed

- **Esc over the queue behaves like the CLI.** The semantics were taken from real
  CLI transcripts: there, cancelling your own queued note and interrupting a turn
  are different gestures (none of the 103 user `queue-operation: remove` entries
  carries an interrupt marker). Zarya did the opposite: Esc interrupted the agent
  while the queued note stayed and went to it by itself once the turn ended. Now: a
  non-empty queue — Esc returns the text to the input line and leaves the agent
  alone; no queue — Esc interrupts.
- **The "ready · type a prompt" line stopped lying.** It was drawn
  unconditionally and sat right under "the agent is answering…" — one screen
  claiming the agent was both working and free. It now appears only when the turn
  is genuinely the human's.
- **Electron 43.1.1 → 43.2.0** — Chromium security patches on the same branch.
- **The release page is published automatically** together with checksums computed
  on the same runner that built the files. It used to be created by hand, which is
  why tag v0.5.2 was left without a release.

### Fixed

- **Dictation silently failed to start after Esc.** The cancel flag was not
  cleared: the next press opened the microphone and immediately cancelled itself,
  and only the third worked. Found by an Opus review.
- **Push-to-talk recorded into the previous microphone.** The hotkey listener held
  stale settings, so the first dictation after switching devices went to the old one
  while the tooltip showed the new. Exactly the silent substitution microphone
  selection was built for.
- **The microphone stayed open forever** if the bar left the screen in the middle
  of opening the device: its cleanup had already run and the stream arrived
  afterwards.
- **Subagent steps no longer litter the feed** — they arrive tagged with
  `parent_tool_use_id` and looked as if the main agent had run a dozen searches
  itself.

## 0.5.2 — "Airlock" (2026-07-27)

### Added

- **Voice input — dictation straight into the input line.** Local and offline:
  sherpa-onnx with Sber's GigaAM v3 model for Russian. The microphone button in the
  bar or holding `Ctrl+Shift+Space`; the text is **inserted** into the field rather
  than sent — recognition makes mistakes and the bar runs commands, so the last word
  is the human's. While recording, the button becomes the indicator: it pulses and
  shows the level. Click mode stops itself after a second and a half of silence, Esc
  cancels. The model (225 MB) is downloaded on demand with a checksum check instead
  of riding in the distributable. Audio is never written to disk and goes nowhere
  (`src/main/sttService.ts`, `src/renderer/src/features/voice/dictation.ts`).
- **Browser-layer permissions limited to an explicit list.** There was no handler
  at all, and Electron without one grants permissions by default. Now the microphone
  and the clipboard — and only for our window (`src/main/index.ts`).

### Changed

- **The bottom bar was rebuilt.** Limits no longer queue up on one line: the bar
  shows one number — the window closest to exhaustion — and the rest expands into a
  panel with a row per limit. The engine and the gate mode are folded into icons
  (spark, ring, star, crescent) with names in tooltips; the gate colour is kept so
  "will I be asked" reads without hovering. The status bar with path and branch was
  brought to the same chip language.
- **The input field became multi-line.** `Shift+Enter` and `Ctrl+Enter` insert a
  line break, the field grows with the text, `Enter` still sends.

### Fixed

- **Esc interrupts the turn instead of tearing down the session.** With Claude Code,
  cancelling closed the whole input queue — the process exited, and your own cancel
  came back as a red "process exited with code 1". Codex and ACP always interrupted
  the turn only; the semantics are now one across all engines. A message sent right
  after Esc is no longer lost silently in a closed queue, and an interrupted turn is
  marked "interrupted": there will be no answer, but the agent will see it when the
  session resumes.
- **Font settings reach what you actually see.** "Font size", "Line height" and
  "Terminal padding" only went to xterm, which is drawn offscreen in Blocks mode —
  nothing changed on screen. They now drive the feed as well. The agent's answer is
  set in a different typeface than the user's line, so at equal pixel sizes it looked
  smaller — the sizes are now matched optically.
- **The app icon stopped looking blurry.** The `.ico` had four sizes, and 48px (the
  one the desktop takes) was a downscale of 256px. There are ten native sizes now,
  including 96px for large icons.

### Security

A continuation of the same audit — MEDIUM findings about the approval gate.

- **"Auto-approve commands" no longer lifts the gate on file edits.** The setting is
  meant for Zarya's built-in agent and its single `run_command` tool, but it was also
  passed to the native drivers as `permissionMode: 'acceptEdits'` — that is the Claude
  Agent SDK's own "auto-accept file edit operations" mode. Write/Edit calls went
  **below** `canUseTool`, i.e. past the app's entire approval system, while AUTOPILOT
  was off and the chip in the bar insisted the agent asks. Native drivers are now
  always given `permissionMode: 'default'`; the gate can be loosened by exactly one
  explicit switch — AUTOPILOT (`src/renderer/src/features/ai/aiStore.ts`,
  `src/shared/types.ts`).
- **The approval card no longer hides what it asks you to approve.** A long or
  multi-line command was collapsed to the first 88 characters of its first line — the
  dangerous part (`&& rm -rf …`, the second and third lines) stayed under the fold
  while "RUN" and Enter were one keystroke away. While a gate is pending, the command
  is pinned in full in a block of its own: it cannot be collapsed, there is no
  truncation and no inner scroll hiding the tail, and multi-line commands are labelled
  with a line count. The title line is not trusted with the text: it shares a row with
  the tool label and truncates at about half the threshold, so a length-based decision
  left a band of commands cut by layout with no way to expand. The feed also scrolls to
  the pending gate — Enter approves from anywhere in the window, so a card off screen
  would be the same blind yes. After a decision the card collapses again: that is
  history now, not a choice (`src/renderer/src/features/ai/gates.ts`,
  `src/renderer/src/components/MissionFeed.tsx`, `tests/gates.test.ts`).
- **The mode chip no longer stays silent or lies.** In built-in agent mode there was
  no chip at all — auto-approve turned on looked exactly like manual mode. With
  Gemini/Kimi/Qwen the opposite: a live "AUTOPILOT" switch was drawn that did
  physically nothing (`setBypass()` is a stub, these engines always ask). The chip now
  exists in every agent mode and shows the switch that actually governs the active
  engine, and for engines without bypass it is locked to "MANUAL". While driver
  capabilities are still loading, the chip shows the setting that will really reach the
  driver rather than "autopilot not supported"
  (`src/renderer/src/components/AgentBar.tsx`, `src/main/acpDriver.ts`).
- **The Codex sandbox no longer lifts the gate behind AUTOPILOT's back.** The thread
  was opened with `sandbox: 'workspaceWrite'` permanently, and `on-request` in that
  combination only asks about what leaves the sandbox: an edit inside the open folder
  was approved by Codex itself, with no request, no card and no trace in the feed,
  while the chip showed "MANUAL". The sandbox now follows the same switch as the
  approval policy; if it differs from the one the thread was opened with, a per-turn
  override is sent — otherwise turning autopilot off mid-conversation left the thread
  writable. The override is sent only on a mismatch: it replaces the policy wholesale
  and would overwrite the user's `[sandbox_workspace_write]` from `~/.codex/config.toml`
  on every turn (`src/main/codexDriver.ts`).
- **The Codex edit card names the files.** A patch approval request carries no paths —
  they arrive in a separate event, and the card showed a faceless "File changes". After
  the sandbox went read-only, ALL edits inside the project started flowing through this
  gate, so editing `src/` became indistinguishable from editing `~/.codex/config.toml` —
  and a frequent nameless gate is exactly what breeds a blind "Enter". Paths are now
  remembered from `item/started` and go into the label; when there is no path at all,
  the card says so instead of a confident constant (`src/main/codexDriver.ts`,
  `src/main/codexProtocol.ts`, `scripts/mock-codex-app-server.mjs`).
- **The feed leads to the gate Enter will approve.** Scrolling went to the end of the
  feed while Enter approves the FIRST unsettled gate: with parallel tool calls one card
  was on screen and a different one got confirmed. The anchor is now the card itself,
  and the "Enter · Esc" hint sits only on it (`src/renderer/src/components/MissionFeed.tsx`,
  `src/renderer/src/features/ai/gates.ts`).
- **Gemini/Kimi/Qwen gates stopped being nameless.** These engines send a human
  description only in `displayName`/`input.title`, and the card in the feed assembled
  its label without them — showing a bare "Bash" or "Edit". That is confirming a command
  whose text was never on screen. The label is now assembled from the gate itself,
  identically in the feed and in the panel (`src/renderer/src/features/ai/gates.ts`,
  `src/renderer/src/components/MissionFeed.tsx`).
- **A terminal profile is no longer added silently.** `terminal.customProfiles` is a
  list of programs the app launches, and the settings channel is reachable from the
  renderer: a compromised renderer could register its own binary and get it started on
  every launch — that is **persistence** surviving a restart. A profile now passes a
  structural check (an absolute path to an existing file, no control characters, bounded
  argv), and only locale, timezone and proxy are let through from the environment — by
  allowlist, because a blocklist does not close: `PROMPT_COMMAND`, `PS0`, `BASH_FUNC_*`,
  `PSModulePath`, `HOME` all give execution, and our own integration scripts read
  `$HOME/.bashrc`. Anything that will start executing anew additionally requires explicit
  confirmation showing the path, the arguments and the variable values; a refusal keeps
  the old list. The profile is re-checked at launch time as well — the settings file is
  also edited by hand (`src/main/shellProfileGuard.ts`, `src/main/ipc.ts`,
  `tests/shellProfileGuard.test.ts`).
- **Detected shells resolve to an absolute path.** WSL profiles held a bare `wsl.exe`,
  and on Windows the loader looks for a program in the child process's working directory
  first — the same search-order trap already closed for git. Detected profiles now also
  take precedence over user ones: a profile with a borrowed id (`pwsh`, `cmd`) no longer
  shadows the system shell that "auto" points at (`src/main/shellProfiles.ts`).

### Changed

- **Build chain updated: electron-builder 24.13.3 → 26.15.3.** Every
  `app-builder-lib < 26.15.0` generates an AppRun with a trailing colon in
  `LD_LIBRARY_PATH` (GHSA-7g7r-gx96-252g), and the linker reads that as the current
  directory — the defect shipped inside the AppImage. The upgrade also cleans the whole
  dev chain: no more `critical` in `npm audit` (was 1), `high` down to 16 from 22.
  Requires Node ≥ 20.19 (26.x loads an ESM dependency through `require`), so the lower
  bound is pinned in `engines`.

### Fixed

- **The file-edit gate in the side panel is no longer empty.** The "IDE agent" panel
  labelled the card from `input.command` only, so an Edit/Write/Read request showed as
  "—": a confirmation without a single word about what is being confirmed. The label is
  now shared with the main feed, and a multi-line command keeps its line breaks
  (`src/renderer/src/features/ai/AiPanel.tsx`, `src/renderer/src/features/ai/gates.ts`).
- **The desktop icon is no longer blurry.** Zarya is drawn natively at every size, but
  the built `.ico` held only four entries (16/32/48/256), and its 48px was a downscale
  from 256 — while the desktop takes exactly 48px. For "large icons" (96px) that size did
  not exist at all: the system took 48 and stretched it. The `.ico` now holds ten native
  sizes (16, 20, 24, 32, 40, 48, 64, 96, 128, 256), and the generator was rewritten in
  Node without Aseprite and without new dependencies — it verifies against the committed
  PNGs and refuses to run on a mismatch, so the drawing is guaranteed to be the same
  (`scripts/gen-zarya-icon.mjs`, `build/icon.ico`).

## 0.5.1 — "Sentry" (2026-07-25)

A security + freshness release. An adversarial audit of the whole attack surface
(process spawning, the Electron/IPC boundary, approval gates, secrets, supply
chain) turned up four ways untrusted content could act with the app's authority
— all closed here. Separately, newly released Claude models now appear on their
own, without rebuilding or restarting Zarya.

### Security

Found by an adversarial audit of the whole attack surface (process spawning,
Electron/IPC boundary, approval gates, secrets, supply chain).

- **A hostile folder no longer executes code just because you opened it.** `git` was
  launched by bare name while the working directory was any directory the user opened.
  On Windows libuv resolves a program name from the child process's cwd **before PATH**,
  so a `git.exe` dropped into a repository, a zip or a shared folder ran in the main
  process — with no approval gate and no trace in the interface, automatically on the
  first git-panel poll. Reproduced experimentally;
  `NoDefaultCurrentDirectoryInExePath` does not help. The path to git is now resolved
  once from trusted locations, and if no trusted git is found the git features are simply
  turned off, with no fallback to a bare name (`src/main/gitService.ts`,
  `tests/gitExe.test.ts`).
- **A link in an agent's answer can no longer take the window to an arbitrary
  `file://`.** The navigation gate treated any `file:` URL as its own origin, and the
  answer feed did not intercept link clicks — a relative link in markdown resolved
  against our own document and loaded a planted local page with full access to the
  preload API (pty.write, files, agent control), i.e. RCE past every gate. Exactly our
  document is now allowed, and links from the feed go to the external browser
  (`src/main/index.ts`, `src/renderer/src/components/MissionFeed.tsx`).
- **An approval gate is never invisible.** The card with the command was drawn only
  from `tool_use` blocks, which only Claude Code sends. With Codex, Gemini, Kimi and
  Qwen the request arrived as a bare event — there was no card **anywhere**, and yet
  Enter approved it faithfully. That is a user confirming a command they never saw. Any
  request without a description now gets its own card in the feed and in the panel
  (`src/renderer/src/features/ai/gates.ts`).
- **A session's working directory can no longer be forged by terminal output.** The
  directory was tracked via OSC 7 / 9;9 / 1337 / 633;P — ordinary output that any
  program can print. That directory becomes the agent's working directory and the root
  its file access is confined to, so a forgery silently widened the sandbox. Shell
  integration now reports the directory over a private channel with a per-session nonce
  (which never reaches child processes), and after the first trusted message all
  unsigned ones are ignored. Shells without integration (cmd.exe, custom profiles) work
  as before — the protection turns itself on, with no settings
  (`src/renderer/src/terminal/cwdTrust.ts`).
- **The dev server is matched by origin, not by string prefix** — a prefix check
  accepted `http://localhost:5920@evil.com/` as our own origin.

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

## 0.5.0 — "Constellation" (2026-07-24)

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

## 0.4.0 — "Orbit" (2026-07-21)

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
- **Pixel logo** — a "ZARYA // ORBIT-1" wordmark in the titlebar (`Titlebar.tsx`).
- **Launch Pad** — a rocket-console overlay for picking the AI **engine (model)**
  and **thrust (effort)**, with a live mission clock and a pixel launch-pad scene;
  **LAUNCH · POYEKHALI** applies both to settings and fires the launch animation
  (`LaunchPad.tsx`). Opened via `Ctrl+Alt+M` (`app.launch-pad`), the command
  palette, or a button in Settings → AI.
- **Reasoning thrust** — a new `AiSettings.effort` (`AiEffort`:
  `low` / `medium` / `high` / `max`) that drives temperature **and** token budget
  through `EFFORT_TUNING` (`src/shared/defaults.ts`). Surfaced as a 4-segment
  thrust bar in both the Launch Pad and Settings → AI.
- **Rocket-launch overlay** — a cinematic "POYEKHALI!" liftoff (countdown, parallax
  star streaks, exhaust embers, screen shake) fired on engine/thrust and
  provider/model changes (`RocketLaunch.tsx`).
- **Mission Control settings** — the settings view is restyled as a control room
  with bilingual labels, a 2-column theme-card picker, a gold −/+ font-size stepper,
  and a dedicated "rocket" toggle reserved for the dangerous auto-approve switch
  (`SettingsView.tsx`).
- **Expanded theme collection** — 9 cosmic-constructivist themes replacing the
  original two: 6 dark (**Kosmos** default, **Vostok**, **Orbit**, **Sputnik**,
  **Baikonur**, **Dawn**) and 3 light "poster paper" themes (**Poster**, **Noon**,
  **Blueprint**). See [docs/themes.md](docs/themes.md).
- **Terminal instrument-panel header** — a thin per-pane strip above each xterm
  surface ("★ CLI AGENT · ZARYA" + the pane's own cwd) (`TerminalPane.tsx`).
- **Fuel strip** — a launch-themed status line in the AI panel (`AiPanel.tsx`) and
  a matching fuel status item in the bottom status bar.
- **Offscreen QA harness** — `scripts/shoot.mjs`, a coverage-independent visual-QA
  tool that boots Zarya in an isolated throwaway instance (Playwright's Electron
  driver, its own `userData`, no single-instance lock, no user sessions) and
  captures the renderer's real pixels regardless of what covers the window or which
  monitor it's on. Supports `--theme`, `--rocket`, `--ui`, `--out`, `--wait`.

### Changed

- **Default theme** is now `zarya-cosmos` (Zarya · Kosmos).
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
