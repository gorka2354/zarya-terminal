import { app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { readJson, writeJsonAtomic } from './jsonStore'
import type { WorkflowDef } from '@shared/types'

export function builtinResourcesDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'app-resources')
    : join(app.getAppPath(), 'resources')
}

export class WorkflowStore {
  private get userFile() {
    return join(app.getPath('userData'), 'workflows.json')
  }

  async list(): Promise<WorkflowDef[]> {
    const builtins: WorkflowDef[] = []
    try {
      const dir = join(builtinResourcesDir(), 'workflows')
      const files = await fs.readdir(dir)
      for (const f of files) {
        if (!f.endsWith('.json')) continue
        const defs = await readJson<WorkflowDef[]>(join(dir, f), [])
        for (const d of defs) builtins.push({ ...d, builtin: true })
      }
    } catch {
      // no builtin pack in dev until resources are created
    }
    const user = await readJson<WorkflowDef[]>(this.userFile, [])
    return [...user, ...builtins]
  }

  async save(wf: WorkflowDef): Promise<void> {
    const user = await readJson<WorkflowDef[]>(this.userFile, [])
    const i = user.findIndex((w) => w.id === wf.id)
    const clean = { ...wf, builtin: false }
    if (i >= 0) user[i] = clean
    else user.push(clean)
    await writeJsonAtomic(this.userFile, user)
  }

  async delete(id: string): Promise<void> {
    const user = await readJson<WorkflowDef[]>(this.userFile, [])
    await writeJsonAtomic(
      this.userFile,
      user.filter((w) => w.id !== id)
    )
  }
}
