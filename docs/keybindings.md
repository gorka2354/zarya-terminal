# Keybindings

Zarya keeps a single flat map of `actionId -> chord` (`Settings.keybindings`, seeded
from `DEFAULT_KEYBINDINGS` in `src/shared/defaults.ts`). Every action is registered
once in a global action registry (`src/renderer/src/lib/actionRegistry.ts`) and the
Command Palette lists exactly the same set — there's no separate, hidden set of
menu-only commands.

## Default bindings

| Action id | Title | Default chord |
|---|---|---|
| `app.command-palette` | Command palette | `Ctrl+Shift+P` |
| `app.quick-open` | Quick open (file) | `Ctrl+P` |
| `app.settings` | Settings | `Ctrl+,` |
| `app.toggle-ai-panel` | Toggle AI panel | `Ctrl+Shift+A` |
| `app.launch-pad` | Launch Pad — AI engine (model) · thrust (effort) | `Ctrl+Alt+M` |
| `app.toggle-sidebar` | Toggle sidebar | `Ctrl+B` |
| `ai.command-bar` | AI: natural language → command | `Ctrl+I` |
| `history.search` | Global command history (Time Machine) | `Ctrl+R` |
| `tab.new` | New tab | `Ctrl+Shift+T` |
| `tab.close` | Close tab | `Ctrl+Shift+W` |
| `tab.next` | Next tab | `Ctrl+Tab` |
| `tab.prev` | Previous tab | `Ctrl+Shift+Tab` |
| `terminal.split-right` | Split right | `Ctrl+Shift+D` |
| `terminal.split-down` | Split down | `Ctrl+Shift+S` |
| `terminal.close-pane` | Close pane | `Ctrl+Shift+X` |
| `terminal.focus-next-pane` | Focus next pane | `Alt+ArrowRight` |
| `terminal.focus-prev-pane` | Focus previous pane | `Alt+ArrowLeft` |
| `terminal.clear` | Clear terminal | `Ctrl+Shift+K` |
| `terminal.search` | Find in terminal | `Ctrl+Shift+F` |
| `terminal.copy` | Copy selection | `Ctrl+Shift+C` |
| `terminal.paste` | Paste | `Ctrl+Shift+V` |
| `blocks.prev` | Previous block | `Ctrl+ArrowUp` |
| `blocks.next` | Next block | `Ctrl+ArrowDown` |
| `blocks.copy-last-output` | Copy last command's output | `Ctrl+Shift+O` |
| `font.increase` | Increase font size | `Ctrl+=` |
| `font.decrease` | Decrease font size | `Ctrl+-` |
| `font.reset` | Reset font size | `Ctrl+0` |

Two more actions exist in the registry without a default chord (bind one yourself if
you want it): `app.toggle-ai-panel`'s sibling `blocks.panel` (toggle the Blocks side
panel).

## How dispatch works

`initKeybindings()` (`src/renderer/src/features/palette/keybindings.ts`) installs a
single capture-phase `keydown` listener on `window`. For every keydown:

1. The event is normalized to a chord string, e.g. `Ctrl+Shift+P`
   (`chordFromEvent` — modifier order is always Ctrl, Alt, Shift, Meta; a bare
   modifier press is ignored).
2. `F12` is hardcoded to open DevTools regardless of the keybindings map.
3. The chord is looked up against every entry in `settings.keybindings` (linear scan —
   the map is small and this runs once per keypress, not per frame).
4. If focus is inside a plain `<input>`/`<textarea>`/`contenteditable` element (but
   *not* the xterm hidden input, `xterm-helper-textarea`) and the chord has no
   modifier besides Shift, typing wins and the binding is skipped — so a shortcut like
   a bare letter won't fire while you're typing in a settings field. Chords with
   Ctrl/Alt/Meta always fire regardless of focus.
5. Otherwise `runAction(actionId)` executes it and the event is prevented/stopped.

The terminal itself (`XtermView`'s `attachCustomKeyEventHandler`) explicitly defers to
this dispatcher for any chord that resolves to an action
(`shouldBypassTerminal(e)` — same chord-to-action lookup), so a global shortcut is never
silently swallowed as terminal input; a couple of terminal-local chords
(`Ctrl+Shift+C`/`Ctrl+Shift+V` for copy/paste, ghost-suggest `→`/`Esc`) are handled
directly by the terminal view before that check.

## Remapping a shortcut

There is no dedicated keybindings editor UI yet — remap by editing the
`keybindings` object directly, either through Settings (once the settings UI exposes
it) or by editing `settings.json` under Zarya's `userData` directory
(`%APPDATA%/Zarya/settings.json` on Windows) while Zarya is closed:

```json
{
  "keybindings": {
    "terminal.split-right": "Ctrl+Alt+D"
  }
}
```

You only need to include the actions you're overriding — `settings.json` is deep-merged
onto `DEFAULT_SETTINGS` on load (`mergeDeep` in `src/main/jsonStore.ts`), so any action
id you don't mention keeps its default chord. A chord is a plain string built from
`Ctrl+`, `Alt+`, `Shift+`, `Meta+` prefixes (any combination, that order) plus a key
name — arrow keys are `ArrowUp`/`ArrowDown`/`ArrowLeft`/`ArrowRight`, everything else is
`e.key` uppercased for single characters (e.g. `P`, `,`, `=`).

Two chords can't currently both be bound to the same action, and binding the same chord
to two actions means whichever is found first in iteration order wins — avoid
collisions by checking the table above before picking a new chord.
