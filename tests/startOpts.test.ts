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
        bypass: false,
        editsAuto: false
      })
  })

  /**
   * Режим плана — единственный, кроме `default`, который сюда допущен, и
   * допущен потому, что он СТРОЖЕ: агент не выполняет ничего.
   */
  describe('режим плана', () => {
    it('уходит драйверу как plan', () => {
      expect(nativeGateOpts(ai(), false, true).permissionMode).toBe('plan')
    })

    it('снимает автопилот, даже если он был включён', () => {
      // «Выполняй без спроса» и «не выполняй ничего» — противоположные ответы
      // на один вопрос. Отправить их вместе значит отправить непонятно что;
      // приоритет у строгого, потому что ошибка в эту сторону стоит лишнего
      // вопроса, а в обратную — сделанной работы, которую не просили.
      expect(nativeGateOpts(ai(), true, true)).toEqual({
        permissionMode: 'plan',
        bypass: false,
        editsAuto: false
      })
    })

    it('выключённый план ничего не меняет', () => {
      expect(nativeGateOpts(ai(), true, false)).toEqual({
        permissionMode: 'default',
        bypass: true,
        editsAuto: false
      })
      expect(nativeGateOpts(ai(), true, undefined)).toEqual({
        permissionMode: 'default',
        bypass: true,
        editsAuto: false
      })
    })

    it('и здесь настройки на режим не влияют', () => {
      for (const autoApprove of [true, false])
        expect(nativeGateOpts(ai({ autoApprove }), undefined, true).permissionMode).toBe('plan')
    })

    it("'acceptEdits' не появляется ни при каком сочетании", () => {
      // Он снимает гейт правки файлов НИЖЕ canUseTool — вне нашего окна
      // одобрений. Ни один путь сюда не должен его выдавать.
      for (const bypass of [true, false, undefined])
        for (const plan of [true, false, undefined])
          expect(nativeGateOpts(ai(), bypass, plan).permissionMode).not.toBe('acceptEdits')
    })
  })

  it('is closed by default', () => {
    expect(nativeGateOpts(DEFAULT_SETTINGS.ai, undefined)).toEqual({
      permissionMode: 'default',
      bypass: false,
      editsAuto: false
    })
  })

  /*
   * Ступень «правки без спроса» (inc-25). Инвариант тот же и здесь: она НЕ
   * превращается в `permissionMode: 'acceptEdits'` — иначе правки снова ушли бы
   * ниже canUseTool, мимо карточек и мимо «поля необратимого». Ступень считается
   * на нашей стороне и отдаётся драйверу отдельным флагом.
   */
  it('«правки без спроса» не подменяют режим движка', () => {
    const o = nativeGateOpts(ai(), false, false, true)
    expect(o.permissionMode).toBe('default')
    expect(o.editsAuto).toBe(true)
    expect(o.bypass).toBe(false)
  })

  it('под автопилотом ступень гасится — иначе чип показывал бы два состояния', () => {
    const o = nativeGateOpts(ai(), true, false, true)
    expect(o.bypass).toBe(true)
    expect(o.editsAuto).toBe(false)
  })

  it('в режиме плана не действует ничто: ни автопилот, ни ступень', () => {
    const o = nativeGateOpts(ai(), true, true, true)
    expect(o.permissionMode).toBe('plan')
    expect(o.bypass).toBe(false)
    expect(o.editsAuto).toBe(false)
  })

  it('нерешённая ступень — это «спрашивать»', () => {
    expect(nativeGateOpts(ai(), false, false, undefined).editsAuto).toBe(false)
  })
})
