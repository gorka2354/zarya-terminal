/**
 * Bridge used by the terminal core to talk to the editor feature without a
 * hard dependency. The editor feature registers its implementation on load.
 */
type OpenFileFn = (path: string, line?: number) => void
type OpenDiffFn = (cwd: string, path: string) => void

let openFileImpl: OpenFileFn | null = null
let openDiffImpl: OpenDiffFn | null = null

export function registerEditorBridge(openFile: OpenFileFn, openDiff: OpenDiffFn): void {
  openFileImpl = openFile
  openDiffImpl = openDiff
}

export function openFileInEditor(path: string, line?: number): void {
  openFileImpl?.(path, line)
}

export function openDiffInEditor(cwd: string, path: string): void {
  openDiffImpl?.(cwd, path)
}
