import { app } from 'electron'
import { existsSync, promises as fs } from 'fs'
import { dirname, join } from 'path'
import { readJson, writeJsonAtomic } from './jsonStore'
import type { WorkflowDef } from '@shared/types'

/**
 * Папка со встроенными ресурсами: скрипты разметки оболочки, готовые workflow.
 *
 * В упакованной сборке путь один и точный. В РАЗРАБОТКЕ его приходится искать:
 * главный процесс собран в `out/main/index.js` и запускается напрямую, поэтому
 * `getAppPath()` возвращает `out/main` — и `resources` искались там, где их
 * никогда не было. Тихо, без единой жалобы: интеграция оболочки подключается
 * «по возможности», и её отсутствие выглядит просто как терминал без блоков.
 * Из-за этого ни один прогон не мог проверить блоки вообще — а именно блоками
 * лента показывает, что команда запустилась.
 *
 * Ищем вверх по дереву от собранного файла: `out/main` → `out` → корень.
 */
export function builtinResourcesDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'app-resources')
  let dir = app.getAppPath()
  for (let up = 0; up < 4; up++) {
    const guess = join(dir, 'resources')
    if (existsSync(join(guess, 'shell-integration'))) return guess
    dir = dirname(dir)
  }
  return join(app.getAppPath(), 'resources')
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
