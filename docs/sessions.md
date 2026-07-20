# Sessions & persistence

Zarya's "sessions survive a reboot" promise is built on three pieces: a periodic
**snapshot** of each live session, a separate **workspace** file for tab/split layout,
and a two-phase **prepare-quit** handshake so a snapshot is taken right before the
process actually dies. All persistence code is in `src/main/sessionStore.ts` (disk) and
`src/renderer/src/state/sessionsStore.ts` (orchestration); the shapes are defined once
in `src/shared/types.ts`.

## What gets saved: `SessionSnapshot`

```ts
interface SessionSnapshot {
  meta: SessionMeta        // id, title, shell, cwd, pinned/favorite, blocksCount, lastCommand…
  scrollback: string       // serialized VT stream (@xterm/addon-serialize)
  blocks: BlockRecord[]    // command/output/exitCode/timestamps for every block
}
```

- **`scrollback`** is produced by `handle.serialize(maxLines)`, a thin wrapper around
  xterm's `SerializeAddon` — it captures the actual terminal buffer (colors, cursor
  position included) as a re-playable VT stream, not a screenshot. `maxLines` is
  `sessions.scrollbackSaveLines` (default **2000**).
- **`blocks`** are the full `BlockRecord[]` for that session from `blocksStore`, with
  each block's `output` capped to the last **20,000 characters**
  (`OUTPUT_SNAPSHOT_CAP` in `sessionsStore.ts`) before it's written — a block's live,
  in-memory copy can be larger (capped at 100,000 chars / 600 lines by `BlockEngine`),
  but only the tail is persisted.
- **What is *not* saved:** the actual OS process. Restoring a session does not
  reattach to anything — it replays the saved scrollback text, prints a
  `сессия восстановлена · новый shell` marker, and spawns a brand-new shell process
  in the session's last known `cwd`. Anything that only existed in that process's
  memory (env vars set mid-session, a `cd`'d-into subshell, background jobs) is gone;
  what's on screen and the command/output history is not.

## Where it lives

`SessionStore` (`src/main/sessionStore.ts`) keeps two things under
`userData/sessions/`:

- `index.json` — `SessionMeta[]`, the lightweight list the Sessions panel reads
  (`sessions:list`). Sorted by `updatedAt` descending on read.
- `<sessionId>.json` — one full `SessionSnapshot` per saved session. The id is
  sanitized to `[a-zA-Z0-9_-]` before touching the filesystem.

Both files are written with `writeJsonAtomic()` (`src/main/jsonStore.ts`): content goes
to a `*.<pid>.tmp` file first, then an atomic rename over the target, with writes to the
same path serialized through a promise queue — so a crash mid-write can't corrupt
`index.json` or a snapshot, and two rapid saves of the same file can't interleave.

`workspace.json` (top-level `userData`, not under `sessions/`) stores the separate
`WorkspaceState` — the tab list and each tab's `SplitNode` layout tree plus which
session is active in each pane. It's what makes splits/tabs come back on relaunch, and
it's intentionally decoupled from individual session snapshots: you can lose a
session's data (pruned, deleted) and the tab layout still reconstructs a fresh empty
pane for it rather than failing to restore the whole tab.

## Autosave

```ts
sessions: {
  restoreOnLaunch: 'workspace' | 'none'  // default: 'workspace'
  autosaveSec: number                     // default: 20 (floor 5)
  scrollbackSaveLines: number             // default: 2000
}
```

On boot, `useSessionsStore.boot()` starts a `setInterval` that calls
`snapshotAll()` every `max(5, autosaveSec)` seconds, snapshotting every currently open
session in sequence. `snapshotAll()` also runs:

- Immediately when a session is closed (unless the caller explicitly opts out via
  `closeSession(id, { save: false })`).
- Before toggling pin/favorite on a *live* session (so the flag isn't lost if the
  process later exits uncleanly).
- On the prepare-quit handshake, below.

The workspace file is saved separately and more eagerly — any tab/split/active-session
change schedules a debounced 700ms save (`schedulePersistWorkspace`).

## Prepare-quit protocol

Because a `BrowserWindow`'s `close` event fires *before* the renderer has a chance to
flush anything, Zarya turns quitting into an explicit two-step handshake instead of
letting Electron tear the window down synchronously:

```mermaid
sequenceDiagram
    participant OS as OS / user (close window)
    participant Main as main/index.ts
    participant Renderer as sessionsStore (renderer)

    OS->>Main: BrowserWindow 'close' event
    Main->>Main: e.preventDefault()
    Main->>Renderer: send('app:prepare-quit', { reason })
    Main->>Main: start 2000ms safety timer
    par renderer flushes
        Renderer->>Renderer: snapshotAll() every open session
        Renderer->>Renderer: saveWorkspace({ tabs, activeTabId })
        Renderer->>Main: send('app:ready-to-quit')
    and safety net
        Main->>Main: if 2000ms elapse first, quit anyway
    end
    Main->>Main: quitConfirmed = true; window.destroy()
```

Whichever happens first — the renderer acking `app:ready-to-quit`, or the 2-second
timer — the window is destroyed. The timer exists so a hung/crashed renderer can never
prevent the app from closing; because autosave already runs on a short interval, the
worst case is losing at most `autosaveSec` seconds of scrollback, not a corrupt or
hung quit.

## Pin / favorite / prune

`SessionMeta.pinned` and `.favorite` are independent booleans, toggled via
`sessions:set-flag`. Both are exempt from pruning:

```ts
const MAX_SESSIONS = 200 // sessionStore.ts

private async prune(): Promise<void> {
  if (this.metas.length <= MAX_SESSIONS) return
  const removable = this.metas
    .filter((m) => !m.pinned && !m.favorite)
    .sort((a, b) => a.updatedAt - b.updatedAt) // oldest first
  const excess = this.metas.length - MAX_SESSIONS
  // delete the oldest `excess` non-pinned, non-favorite sessions
}
```

Pruning runs inside `saveSnapshot()`, i.e. on every autosave tick across every open
session — the cap is enforced continuously, not just at startup. A pinned or favorited
session can never be pruned regardless of age; the only way to remove one is an
explicit `sessions:delete` (the "Delete session" action, which is disabled in the UI
while that session is still open).

## Restore flow

On launch, if `sessions.restoreOnLaunch === 'workspace'`:

1. Load `workspace.json`. If it has tabs, for every leaf session id in every tab's
   split tree: load that session's snapshot (`sessions:load-snapshot`).
2. If a snapshot exists: seed `blocksStore` with its blocks, stash its scrollback via
   `setPendingRestore(id, scrollback)` (replayed into xterm the moment `XtermView`
   mounts for that id — before any live PTY data arrives), and mark the runtime
   session `restored: true`.
3. If no snapshot exists for a leaf (e.g. it was pruned or deleted since the workspace
   was saved), a **fresh** session id is minted for that pane instead of failing the
   whole tab.
4. Spawn a new shell for every session in the reconstructed layout, in the session's
   saved `cwd` (falling back to the OS home directory if that path no longer exists —
   handled in `PtyManager.spawn`).

If `restoreOnLaunch` is `'none'`, or there's no saved workspace, or restoring produced
zero tabs, a single fresh tab is opened instead — Zarya never boots with zero tabs.
