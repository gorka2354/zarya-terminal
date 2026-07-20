import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { readJson, writeJsonAtomic } from './jsonStore'
import type { SessionMeta, SessionSnapshot, WorkspaceState } from '@shared/types'

/** Sessions older than the cap are pruned, except pinned/favorite ones. */
const MAX_SESSIONS = 200

export class SessionStore {
  private metas: SessionMeta[] = []
  private loaded = false

  private get dir() {
    return join(app.getPath('userData'), 'sessions')
  }
  private get indexFile() {
    return join(this.dir, 'index.json')
  }
  private get workspaceFile() {
    return join(app.getPath('userData'), 'workspace.json')
  }
  private snapshotFile(id: string) {
    return join(this.dir, `${id.replace(/[^a-zA-Z0-9_-]/g, '')}.json`)
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.metas = await readJson<SessionMeta[]>(this.indexFile, [])
    this.loaded = true
  }

  async list(): Promise<SessionMeta[]> {
    await this.ensureLoaded()
    return [...this.metas].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async saveSnapshot(snap: SessionSnapshot): Promise<void> {
    await this.ensureLoaded()
    const i = this.metas.findIndex((m) => m.id === snap.meta.id)
    if (i >= 0) {
      // Preserve user flags if the incoming meta lost them (belt and braces).
      snap.meta.pinned = snap.meta.pinned || this.metas[i].pinned
      snap.meta.favorite = snap.meta.favorite || this.metas[i].favorite
      this.metas[i] = snap.meta
    } else {
      this.metas.push(snap.meta)
    }
    // Write the new snapshot file BEFORE pruning/indexing, so index.json can
    // never reference this entry before its file exists on disk (crash-safe:
    // orphan files are harmless, orphan index entries are not).
    await writeJsonAtomic(this.snapshotFile(snap.meta.id), snap)
    await this.prune()
    await writeJsonAtomic(this.indexFile, this.metas)
  }

  async loadSnapshot(id: string): Promise<SessionSnapshot | null> {
    await this.ensureLoaded()
    const snap = await readJson<SessionSnapshot | null>(this.snapshotFile(id), null)
    return snap
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded()
    this.metas = this.metas.filter((m) => m.id !== id)
    await writeJsonAtomic(this.indexFile, this.metas)
    await fs.rm(this.snapshotFile(id), { force: true })
  }

  async setFlag(id: string, flag: 'pinned' | 'favorite', value: boolean): Promise<void> {
    await this.ensureLoaded()
    const m = this.metas.find((x) => x.id === id)
    if (!m) return
    m[flag] = value
    await writeJsonAtomic(this.indexFile, this.metas)
    const snap = await this.loadSnapshot(id)
    if (snap) {
      snap.meta[flag] = value
      await writeJsonAtomic(this.snapshotFile(id), snap)
    }
  }

  async rename(id: string, title: string): Promise<void> {
    await this.ensureLoaded()
    const m = this.metas.find((x) => x.id === id)
    if (!m) return
    m.title = title
    await writeJsonAtomic(this.indexFile, this.metas)
    // Keep the snapshot file's embedded meta.title in sync (mirrors setFlag
    // below) — otherwise a restart reloads the snapshot and the title reverts.
    const snap = await this.loadSnapshot(id)
    if (snap) {
      snap.meta.title = title
      await writeJsonAtomic(this.snapshotFile(id), snap)
    }
  }

  async saveWorkspace(ws: WorkspaceState): Promise<void> {
    await writeJsonAtomic(this.workspaceFile, ws)
  }

  async loadWorkspace(): Promise<WorkspaceState | null> {
    return readJson<WorkspaceState | null>(this.workspaceFile, null)
  }

  private async prune(): Promise<void> {
    if (this.metas.length <= MAX_SESSIONS) return
    const removable = this.metas
      .filter((m) => !m.pinned && !m.favorite)
      .sort((a, b) => a.updatedAt - b.updatedAt)
    const excess = this.metas.length - MAX_SESSIONS
    const victims = removable.slice(0, excess)
    const victimIds = new Set(victims.map((v) => v.id))
    // Update the index and persist it BEFORE deleting any snapshot files: if
    // the process dies mid-prune, at worst we leak orphan files (harmless),
    // never an index.json entry pointing at an already-deleted file.
    this.metas = this.metas.filter((m) => !victimIds.has(m.id))
    await writeJsonAtomic(this.indexFile, this.metas)
    for (const victim of victims) {
      await fs.rm(this.snapshotFile(victim.id), { force: true })
    }
  }
}
