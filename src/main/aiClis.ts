import { execFile } from 'child_process'
import { promisify } from 'util'
import type { AiCli } from '@shared/types'

const execFileAsync = promisify(execFile)

/** Known AI coding CLIs we can launch straight into the terminal. */
/*
 * Команда установки указана ТОЛЬКО там, где мы её знаем наверняка — у трёх
 * агентов, которые ставятся одним npm-пакетом. Остальным даём адрес проекта:
 * подсказка с выдуманной командой хуже отсутствия подсказки, потому что
 * человек её выполнит, получит ошибку и решит, что сломана Заря.
 */
const KNOWN: Array<Omit<AiCli, 'detected' | 'path'>> = [
  {
    id: 'claude',
    name: 'Claude Code',
    cmd: 'claude',
    glyph: 'CC',
    tint: 'accent',
    install: 'npm install -g @anthropic-ai/claude-code',
    site: 'https://code.claude.com/docs'
  },
  {
    id: 'codex',
    name: 'Codex',
    cmd: 'codex',
    glyph: 'CX',
    tint: 'accent-2',
    install: 'npm install -g @openai/codex',
    site: 'https://github.com/openai/codex'
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    cmd: 'gemini',
    glyph: 'GM',
    tint: 'accent-2',
    install: 'npm install -g @google/gemini-cli',
    site: 'https://github.com/google-gemini/gemini-cli'
  },
  {
    id: 'aider',
    name: 'Aider',
    cmd: 'aider',
    glyph: 'AI',
    tint: 'accent',
    site: 'https://aider.chat'
  },
  {
    id: 'cursor-agent',
    name: 'Cursor Agent',
    cmd: 'cursor-agent',
    glyph: 'Cu',
    tint: 'accent',
    site: 'https://cursor.com'
  },
  {
    id: 'ollama',
    name: 'Ollama',
    cmd: 'ollama run llama3',
    glyph: 'OL',
    tint: 'accent-2',
    site: 'https://ollama.com'
  }
]

async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', [
      cmd
    ])
    const first = stdout.split(/\r?\n/).find((l) => l.trim())
    return first?.trim() ?? null
  } catch {
    return null
  }
}

let cache: AiCli[] | null = null

/**
 * Probe PATH for each known AI CLI. Returns the full list with `detected` +
 * resolved `path` so the launcher can show installed ones prominently and
 * offer install hints for the rest.
 */
export async function detectAiClis(): Promise<AiCli[]> {
  if (cache) return cache
  cache = await Promise.all(
    KNOWN.map(async (c) => {
      // The command to probe is the first token of `cmd` (e.g. "ollama run …").
      const bin = c.cmd.split(/\s+/)[0]
      const path = await which(bin)
      return { ...c, path, detected: !!path }
    })
  )
  return cache
}
