# Shell integration protocol

Zarya's blocks, cwd tracking and Time Machine all depend on the running shell emitting
a small set of ANSI OSC (Operating System Command) escape sequences. This is the same
family of standards used by iTerm2, VS Code, Warp and Windows Terminal — Zarya adds
exactly one private extension on top (OSC 6973) to reliably recover the *exact* command
line, which OSC 133 alone doesn't guarantee.

All parsing lives in `BlockEngine` (`src/renderer/src/terminal/blockEngine.ts`), which
registers handlers on xterm's OSC parser via `term.parser.registerOscHandler(id, cb)`.

## OSC 133 — prompt / command marks

The [final-term / FinalTerm](https://gitlab.freedesktop.org/Per_Bothner/specifications/blob/master/proposals/semantic-prompts.md)
convention, also used by VS Code, iTerm2 and Windows Terminal:

| Mark | Meaning | When Zarya emits/consumes it |
|---|---|---|
| `OSC 133;A ST` | **Prompt start.** A new prompt is about to be drawn. | Closes any block still open without a `D` (rare edge case), starts a new visual separator if `blocks.separators` is on. |
| `OSC 133;B ST` | **Prompt end / input start.** Everything after this until `C` is what the user is typing. | Enables ghost-text autosuggest tracking (only suggests while in this phase). |
| `OSC 133;C ST` | **Command execution start.** The user pressed Enter; the command is about to run. | Creates a new `BlockRecord`, places an xterm marker at the current line to capture output later. |
| `OSC 133;D[;exit-code] ST` | **Command finished**, optionally with an exit code. | Finalizes the block: reads captured output from the marker to the cursor, stores exit code, pushes to Time Machine (`history:add`) if a command was captured. |

`ST` is either `BEL` (`\x07`, used by all three shipped integration scripts) or
`ESC \` — xterm accepts either terminator.

## OSC 7 / 9;9 / 1337 — current working directory

Three cwd-reporting conventions are accepted, in this priority (last one to fire wins):

- **OSC 7** — `ESC ] 7 ; file://hostname/path BEL` (used by bash/zsh integration and
  most Unix shells). Percent-decoded; a leading `/C:/...` style path is converted to
  `C:\...` for Windows targets.
- **OSC 9;9** — `ESC ] 9;9;"C:\path" BEL` (Windows Terminal convention, used by the
  PowerShell integration).
- **OSC 1337** — `ESC ] 1337;CurrentDir=/path BEL` (iTerm2 convention, accepted for
  compatibility with tools that already emit it).

A cwd change is broadcast on the internal event bus (`terminal:cwd-changed`) and updates
the session's title (unless the user renamed it) and the git-status widget in the status
bar.

## OSC 6973;E — Zarya command line (with anti-spoofing nonce)

```
ESC ] 6973 ; E ; <base64 of the exact command line> ; <nonce> BEL
```

OSC 133 tells you a command *ran*, but not reliably *what* it was — some shells don't
have a clean hook for the literal input line. OSC 6973;E closes that gap: the
integration script base64-encodes the just-submitted line and appends a **nonce** that
was minted by the main process at PTY spawn time (`PtyManager.spawn`, `randomBytes(16)`)
and injected into the shell's environment as `ZARYA_NONCE` — which the integration
script reads once and immediately `unset`/`Remove-Item`s so it can never leak to a
child process or be read by `env`/`printenv` from inside the session.

**Why the nonce matters:** without it, a malicious script could simply `printf` a fake
`OSC 6973;E;...` sequence to make Zarya believe a different command ran than the one
actually executed (log/UI spoofing — the real command still executes normally either
way, but the recorded block, AI context and Time Machine entry would lie about it).
`BlockEngine.setCommandText()` compares the nonce on every 6973;E payload against the
nonce the renderer received for that session at spawn time (`RuntimeSession.nonce`) and
silently drops the payload on a mismatch.

`OSC 633;E` (VS Code's own private extension) is also accepted for compatibility, with
its own escaping scheme (`\xHH`, `\\`) and optional trailing nonce — same
verify-or-drop behavior applies if a nonce is present.

## Wiring per shell

Integration is injected by `PtyManager.spawn()` (`src/main/ptyManager.ts`) based on the
resolved `ShellProfile.integration` field, from scripts in `resources/shell-integration/`:

| Shell | `integration` kind | How it's loaded | Script |
|---|---|---|---|
| PowerShell (5.1 and 7+, `pwsh`) | `powershell` | `-NoLogo -NoExit -ExecutionPolicy Bypass -Command ". '<script>'"` | `integration.ps1` |
| bash (incl. Git Bash on Windows) | `bash` | `--rcfile <script> -i` | `integration.bash` |
| zsh | `zsh` | `ZDOTDIR` pointed at a generated dir whose `.zshrc` sources the user's real `~/.zshrc` first, then the integration script | `integration.zsh` |
| Command Prompt (`cmd.exe`), Fish, WSL distros | `none` | not injected — plain terminal, no blocks/cwd/history | — |

Each script:
1. Sources/preserves the user's existing shell config and prompt first — Zarya
   *augments*, it doesn't replace `.bashrc`/`.zshrc`/a custom `prompt` function.
2. Is idempotent (`__zarya_loaded` / `$Global:__ZaryaIntegrated` guards) so re-sourcing
   is a no-op.
3. Reads and immediately clears `ZARYA_NONCE` from the environment.
4. Wires precmd/preexec (bash: `PROMPT_COMMAND` + `PS0`; zsh: `add-zsh-hook`;
   PowerShell: overrides the `prompt` function and `PSConsoleHostReadLine`) to emit the
   marks above.

In dev, scripts are read from `<repo>/resources/shell-integration`; in a packaged build,
from `resourcesPath/app-resources/shell-integration` (`extraResources` in
`electron-builder.yml`). If a script is missing on disk for any reason, Zarya falls back
to spawning the shell with no integration — you get a normal terminal, no blocks.

## Adding your own shell

1. Add a `ShellProfile` (id, `path`, `args`, `icon`, and an `integration` kind) —
   either detected automatically in `src/main/shellProfiles.ts`, or as a
   `terminal.customProfiles` entry in Settings (persisted in `settings.json`).
2. If you want blocks/cwd/history for it, write an integration script that:
   - Reads `ZARYA_NONCE` from the environment once, then unsets it.
   - On prompt render: emit `133;A`, an OSC 7/9;9/1337 cwd sequence, then `133;B`.
   - Right before running a command: emit `133;C`, then
     `6973;E;<base64(command)>;<nonce>`.
   - Right after a command finishes: emit `133;D;<exit code>`.
3. Reuse an existing `integration: 'powershell' | 'bash' | 'zsh'` kind if your shell's
   syntax is close enough (e.g. a bash-compatible shell can often reuse
   `integration.bash` verbatim), or add a new `ShellIntegrationKind` in
   `src/shared/types.ts` and a matching branch in `PtyManager.spawn()`.
