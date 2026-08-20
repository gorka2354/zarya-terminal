import { describe, expect, it } from 'vitest'
import { cmdPrompt, integrationGuaranteed, wslIntegrationEnv } from '../src/shared/shellIntegration'

/**
 * Две оболочки, которые не умеют грузить наш скрипт, — и обе на Windows.
 *
 * Разведка 2026-08-19: в Командной строке и в WSL каталог панели замирал на том,
 * с которого её открыли, и не двигался ни на один `cd`. А каталог панели — не
 * подпись под вкладкой: его получает агент как рабочую папку. «Панель показывает
 * не тот каталог» значит «агент правит не тот проект».
 */
describe('cmdPrompt — единственный шов Командной строки', () => {
  it('сообщает каталог последовательностью, которую Заря уже понимает', () => {
    // OSC 9;9 — то же, чем пользуется Терминал Windows; $P — диск и путь.
    expect(cmdPrompt()).toContain('$e]9;9;$P$e\\')
  })

  it('своё приглашение человека сохраняется целиком', () => {
    const mine = '$T$G '
    expect(cmdPrompt(mine).endsWith(mine)).toBe(true)
  })

  it('без своего подставляется ровно то, что cmd показал бы сам', () => {
    /*
     * Не «что-нибудь похожее»: подменив приглашение на своё, мы поменяли бы
     * человеку вид оболочки ради собственной подсказки.
     */
    expect(cmdPrompt()).toBe('$e]9;9;$P$e\\$P$G')
    expect(cmdPrompt('   ')).toBe('$e]9;9;$P$e\\$P$G')
  })

  it('накладываясь дважды, приглашение не растёт', () => {
    // Панель могут перезапустить в том же окружении; две подсказки подряд — это
    // уже мусор в чужой переменной.
    const once = cmdPrompt()
    expect(cmdPrompt(once).split('9;9').length - 1).toBe(2)
    // (Заря собирает PROMPT из окружения СВОЕГО процесса, а не из прошлой
    // панели, — вот почему в жизни этого не случается.)
  })
})

describe('wslIntegrationEnv — как достучаться до оболочки внутри дистрибутива', () => {
  const si = 'C:\\Program Files\\Zarya\\resources\\shell-integration\\integration.bash'

  it('путь к скрипту помечен как путь — систему просят перевести его самой', () => {
    const env = wslIntegrationEnv(si)
    expect(env.ZARYA_SI).toBe(si)
    expect(env.WSLENV.split(':')).toContain('ZARYA_SI/p')
  })

  it('bash подключит скрипт сам, до первого приглашения, и ровно один раз', () => {
    const env = wslIntegrationEnv(si)
    expect(env.PROMPT_COMMAND).toContain('source "$ZARYA_SI"')
    // unset — иначе скрипт грузился бы на каждой строке приглашения.
    expect(env.PROMPT_COMMAND).toContain('unset PROMPT_COMMAND')
    expect(env.WSLENV.split(':')).toContain('PROMPT_COMMAND')
  })

  it('внутрь проносится и признак «мы под Windows», и нонс', () => {
    const env = wslIntegrationEnv(si)
    expect(env.ZARYA_WSL_HOST).toBe('1')
    expect(env.ZARYA_SI_BOOTSTRAP).toBe('1')
    for (const v of ['ZARYA_NONCE', 'ZARYA_WSL_HOST', 'ZARYA_SI_BOOTSTRAP']) {
      expect(env.WSLENV.split(':'), v).toContain(v)
    }
  })

  it('чужой WSLENV не затирается', () => {
    /*
     * WSLENV человек мог настроить под себя — там живут его собственные
     * пробросы. Затерев его, мы отняли бы работающую настройку ради своей.
     */
    const env = wslIntegrationEnv(si, 'MY_TOKEN:PROJECT_ROOT/p')
    const list = env.WSLENV.split(':')
    expect(list[0]).toBe('MY_TOKEN')
    expect(list[1]).toBe('PROJECT_ROOT/p')
    expect(list).toContain('ZARYA_SI/p')
  })

  it('и не удваивается, если Заря там уже прописана', () => {
    const env = wslIntegrationEnv(si, 'ZARYA_SI/p:ZARYA_NONCE')
    const list = env.WSLENV.split(':')
    expect(list.filter((v) => v === 'ZARYA_SI/p')).toHaveLength(1)
    expect(list.filter((v) => v === 'ZARYA_NONCE')).toHaveLength(1)
  })
})

describe('integrationGuaranteed — за кого можно ручаться', () => {
  it('оболочки, которым скрипт отдан в руки', () => {
    for (const k of ['powershell', 'bash', 'zsh']) {
      expect(integrationGuaranteed(k), k).toBe(true)
    }
  })

  it('Командная строка — нет: она сообщает каталог, но не команды', () => {
    /*
     * Признак решает, скажет ли Заря агенту «эта оболочка о командах не
     * рассказывает» вместо пустого списка. Пустой список агент прочитает
     * единственным доступным ему образом — «человек ничего не запускал» — и
     * скажет это вслух тому, у кого экран полон команд.
     */
    expect(integrationGuaranteed('cmd')).toBe(false)
  })

  it('WSL — тоже нет: оболочку внутри дистрибутива выбирает не Заря', () => {
    // Там может оказаться zsh, fish или busybox. Пообещав блоки, мы получили бы
    // ровно ту ложь, от которой признак и заведён.
    expect(integrationGuaranteed('wsl')).toBe(false)
  })

  it('и незнакомое имя — не повод ручаться', () => {
    expect(integrationGuaranteed('none')).toBe(false)
    expect(integrationGuaranteed('')).toBe(false)
    expect(integrationGuaranteed('powershell7')).toBe(false)
  })
})
