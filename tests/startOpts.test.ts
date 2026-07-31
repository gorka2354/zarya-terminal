import { describe, expect, it } from 'vitest'
import { nativeGateOpts } from '@/features/ai/startOpts'
import { DEFAULT_SETTINGS } from '@shared/defaults'
import type { AiSettings } from '@shared/types'

/**
 * Regression guard for a confirmed MEDIUM finding: `ai.autoApprove` — the built-in
 * agent's run_command switch — was sent to native drivers as
 * `permissionMode: 'acceptEdits'`, the Claude Agent SDK's "auto-accept file edit
 * operations". File edits then bypassed `canUseTool` entirely, below the app's
 * approval UI, while АВТОПИЛОТ was off and the bar read «РУЧНОЙ».
 *
 * Инвариант: нативный гейт ослабляет АВТОПИЛОТ и ничто другое. С inc-17 автопилот
 * принадлежит БЕСЕДЕ, а не настройкам: один переключатель на окно с несколькими
 * панелями неизбежно врал бы о том, спросят ли вас — выключаешь, глядя на одну
 * панель, а агент в третьей продолжает выполнять команды сам. Поэтому здесь же
 * проверяется, что настройки на это решение больше не влияют вовсе.
 */
const ai = (over: Partial<AiSettings> = {}): AiSettings => ({
  ...DEFAULT_SETTINGS.ai,
  ...over
})

describe('nativeGateOpts', () => {
  it('never derives a permission mode from autoApprove', () => {
    for (const autoApprove of [true, false])
      for (const bypass of [true, false, undefined])
        expect(nativeGateOpts(ai({ autoApprove }), bypass).permissionMode).toBe('default')
  })

  it("never sends 'acceptEdits' — it removes the file-edit gate below canUseTool", () => {
    for (const autoApprove of [true, false])
      for (const bypass of [true, false, undefined])
        expect(nativeGateOpts(ai({ autoApprove }), bypass).permissionMode).not.toBe('acceptEdits')
  })

  it('гейт ослабляет только АВТОПИЛОТ этой беседы', () => {
    expect(nativeGateOpts(ai({ autoApprove: true }), false).bypass).toBe(false)
    expect(nativeGateOpts(ai({ autoApprove: false }), true).bypass).toBe(true)
  })

  it('нерешённое считается «спрашивать»', () => {
    // Новая панель всегда открывается со спрашиванием: наследовать автопилот от
    // соседней беседы или от настроек нельзя — это вооружало бы панели, на
    // которые человек не смотрел.
    expect(nativeGateOpts(ai(), undefined).bypass).toBe(false)
  })

  it('настройки на автопилот больше не влияют', () => {
    for (const autoApprove of [true, false])
      expect(nativeGateOpts(ai({ autoApprove }), undefined)).toEqual({
        permissionMode: 'default',
        bypass: false
      })
  })

  it('is closed by default', () => {
    expect(nativeGateOpts(DEFAULT_SETTINGS.ai, undefined)).toEqual({
      permissionMode: 'default',
      bypass: false
    })
  })
})
