import type { GitFileStatus, GitStatus } from './types'

/**
 * «Что изменилось» — разбор состояния рабочего дерева для показа человеку.
 *
 * Зачем отдельный модуль, а не пара строк в компоненте: это единственное место
 * во всей затее с откатом, которое видит ВСЕ изменения — и правки агента, и
 * последствия команд оболочки (`npm install`, `rm`, сборка), и работу соседней
 * панели, и то, что человек написал руками. Родной откат движка не покрывает
 * ничего из этого, кроме собственных правок инструментов (см.
 * `inc/inc-33-otkat-koda.md`), поэтому здесь нельзя ошибиться в мелочи: строка
 * «удалён» напротив файла, который на самом деле цел, стоит дороже, чем
 * отсутствие всей панели.
 *
 * Чистая функция и отдельный тест — потому что живые прогоны с git CI не гоняет.
 */

export type ChangeKind = 'deleted' | 'renamed' | 'modified' | 'added' | 'untracked'

export interface ChangedFile {
  /** Путь относительно корня репозитория — как его отдаёт git. */
  path: string
  kind: ChangeKind
  /** Сырой двухбуквенный код git: нужен подсказкой, когда наш разбор спорен. */
  raw: string
  /**
   * Это каталог целиком, а не файл.
   *
   * `git status` схлопывает неотслеживаемый каталог в одну строку с косой
   * чертой на конце (`dist/`) — перечислять его содержимое пришлось бы флагом
   * `-uall`, а он на проекте без `.gitignore` выдаёт десятки тысяч строк.
   * Схлопнутая строка честна, но диффа у каталога не бывает: раскрытие такой
   * строки обещало бы содержимое, которого нет. Поэтому признак едет сюда, а
   * панель на нём гасит раскрытие.
   */
  dir?: boolean
}

/**
 * Порядок — по цене ошибки, а не по алфавиту.
 *
 * Человек читает список сверху и почти никогда не досматривает до конца.
 * Пропущенное удаление стоит дороже пропущенного нового файла, поэтому
 * удаления идут первыми, а неотслеживаемые (обычно это сборка и логи) —
 * последними.
 */
const ORDER: Record<ChangeKind, number> = {
  deleted: 0,
  renamed: 1,
  modified: 2,
  added: 3,
  untracked: 4
}

/**
 * Двухбуквенный код porcelain v2 → один понятный глагол.
 *
 * Буквы две, потому что git отдельно помнит индекс и рабочее дерево: `AD` —
 * файл добавлен в индекс и уже удалён с диска. Показывать человеку «добавлен»
 * в этом случае — соврать про то, что лежит на диске СЕЙЧАС, а панель отвечает
 * именно на этот вопрос. Поэтому удаление и переименование выигрывают у
 * добавления, а не побеждает первая буква.
 */
export function changeKind(raw: string): ChangeKind {
  const s = raw.trim()
  if (s === '??' || s === '!') return 'untracked'
  if (s.includes('D')) return 'deleted'
  if (s.includes('R') || s.includes('C')) return 'renamed'
  if (s.includes('A')) return 'added'
  return 'modified'
}

/** Файлы в порядке показа. Без git (или вне репозитория) — пустой список. */
export function listChanges(status: GitStatus | null | undefined): ChangedFile[] {
  if (!status?.files?.length) return []
  const seen = new Map<string, ChangedFile>()
  for (const f of status.files) {
    const file = toChanged(f)
    // Один путь может прийти дважды (индекс и рабочее дерево). Оставляем более
    // тяжёлый разбор: иначе `AD` покажется просто «добавлен».
    const prev = seen.get(file.path)
    if (!prev || ORDER[file.kind] < ORDER[prev.kind]) seen.set(file.path, file)
  }
  return [...seen.values()].sort(
    (a, b) => ORDER[a.kind] - ORDER[b.kind] || a.path.localeCompare(b.path)
  )
}

function toChanged(f: GitFileStatus): ChangedFile {
  const path = f.path.replace(/\\/g, '/')
  const out: ChangedFile = { path, kind: changeKind(f.status), raw: f.status.trim() }
  if (path.endsWith('/')) out.dir = true
  return out
}

export interface ChangesSummary {
  total: number
  deleted: number
  renamed: number
  modified: number
  added: number
  untracked: number
}

/** Сводка числами над списком: масштаб читается, не разворачивая ни одного файла. */
export function summarize(files: ChangedFile[]): ChangesSummary {
  const out: ChangesSummary = {
    total: files.length,
    deleted: 0,
    renamed: 0,
    modified: 0,
    added: 0,
    untracked: 0
  }
  for (const f of files) out[f.kind] += 1
  return out
}
