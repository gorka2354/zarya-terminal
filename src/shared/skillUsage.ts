/**
 * История срабатываний скиллов — по дням, на этой машине.
 *
 * ЗАЧЕМ. Одна беседа отвечает «сработал 1 из 83», и по этому числу решать
 * нечего: остальные 82 могли сработать вчера в другой задаче. Вопрос, ради
 * которого человек сюда приходит, — «что из оплаченного не работает ВООБЩЕ», а
 * на него отвечает только история.
 *
 * ЧТО ЭТО НЕ ТЕЛЕМЕТРИЯ. Файл лежит в данных Зари, никуда не отправляется и
 * содержит только имена скиллов самого человека и счётчики. Никаких запросов,
 * ответов, путей и времени суток — из такой записи нельзя восстановить, ЧТО он
 * делал, только «скилл X срабатывал N раз в такой-то день».
 *
 * ЧЕСТНОСТЬ ПЕРИОДА. «Ни разу за 30 дней» нельзя говорить на второй день
 * наблюдения — это была бы неправда, за которую человек выключит рабочий скилл.
 * Поэтому наружу всегда идёт `observedDays`: сколько мы РЕАЛЬНО смотрим.
 */

/** Сколько дней истории храним. Дальше — уборка: это счётчик, а не архив. */
export const KEEP_DAYS = 30

/**
 * Сколько разных имён помещается в один день.
 *
 * Скиллы человек создаёт руками, и сотня — это уже много. Предел стоит не
 * против него, а против чужого движка, который однажды начнёт присылать
 * сгенерированные имена: файл Зари не должен расти без предела ни при каких
 * входных данных.
 */
export const MAX_PER_DAY = 200

export interface SkillUsageFile {
  /** Когда начали считать. Без него «ни разу» неотличимо от «не смотрели». */
  since: number
  /** день (`ГГГГ-ММ-ДД`) → имя скилла → сколько раз */
  days: Record<string, Record<string, number>>
}

export interface SkillUsageSummary {
  /** Сколько дней наблюдаем — ровно столько, сколько правда. */
  observedDays: number
  /** Имя скилла → сколько раз сработал за это время. */
  counts: Record<string, number>
}

/** День как ключ файла. Местный, а не UTC: «сегодня» у человека своё. */
export function dayKey(at: number): string {
  const d = new Date(at)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Сколько суток прошло с `since` — минимум один: сегодня уже наблюдаем. */
export function observedDays(since: number, now: number): number {
  if (!since || since > now) return 1
  return Math.max(1, Math.floor((now - since) / 86_400_000) + 1)
}

function cleanName(v: unknown): string {
  if (typeof v !== 'string') return ''
  // Обрезаем длину: имя скилла — это имя папки, а не место для чужого текста.
  return v.trim().slice(0, 80)
}

/**
 * Записать срабатывания и убрать старое.
 *
 * Чистая функция: стор читает файл, зовёт это, пишет обратно. Уборка здесь же,
 * а не отдельной задачей по расписанию, — файл не может распухнуть между
 * уборками, если уборка случается при каждой записи.
 */
export function noteUsage(
  file: SkillUsageFile | undefined,
  names: string[],
  now: number
): SkillUsageFile {
  const since = file?.since && file.since > 0 ? file.since : now
  const days: Record<string, Record<string, number>> = { ...(file?.days ?? {}) }
  const key = dayKey(now)
  const today = { ...(days[key] ?? {}) }
  for (const raw of names) {
    const name = cleanName(raw)
    if (!name) continue
    // Новое имя сверх предела не заводим, но УЖЕ известному счётчик крутим:
    // иначе после переполнения статистика тихо замерла бы.
    if (today[name] === undefined && Object.keys(today).length >= MAX_PER_DAY) continue
    today[name] = (today[name] ?? 0) + 1
  }
  days[key] = today
  return { since, days: onlyRecent(days, now) }
}

/**
 * Оставить дни за последние `KEEP_DAYS` СУТОК — по календарю, а не по счёту.
 *
 * Резать «последние 30 записей» нельзя: день заводится только тогда, когда
 * скилл сработал, и у человека, работающего через день, тридцать записей
 * растягиваются на два месяца. Тогда подпись «за 30 дн.» становится ложью, а
 * скилл, умерший в июне, не попадает в «ни разу не сработали» — то есть за него
 * продолжают платить в каждом запросе именно из-за нашей арифметики.
 */
function onlyRecent(
  days: Record<string, Record<string, number>>,
  now: number
): Record<string, Record<string, number>> {
  // Ключи вида `ГГГГ-ММ-ДД` сравниваются как строки — на то и формат.
  const oldest = dayKey(now - (KEEP_DAYS - 1) * 86_400_000)
  const out: Record<string, Record<string, number>> = {}
  for (const k of Object.keys(days).sort()) {
    // Ключи из будущего (перевели часы назад) не выбрасываем: данные настоящие,
    // и терять их из-за системного времени — хуже, чем показать лишний день.
    if (k >= oldest) out[k] = days[k]
  }
  return out
}

/** Сводка за всё, что храним: сколько раз сработал каждый и сколько мы смотрим. */
export function summarize(file: SkillUsageFile | undefined, now: number): SkillUsageSummary {
  const counts: Record<string, number> = {}
  // Складываем ТОЛЬКО дни внутри периода, который назовём человеку. Файл мог
  // пролежать без записей месяц — тогда в нём есть старые ключи, которые уборка
  // ещё не трогала, и без этого фильтра «3× за 30 дн.» означало бы «3 раза
  // когда-то», а мёртвый скилл выглядел бы живым.
  for (const day of Object.values(onlyRecent(file?.days ?? {}, now))) {
    for (const [name, n] of Object.entries(day ?? {})) {
      if (typeof n === 'number' && n > 0) counts[name] = (counts[name] ?? 0) + n
    }
  }
  // Наблюдаем не дольше, чем храним: после уборки данных за 40-й день нет, и
  // говорить «за 40 дней» было бы обещанием того, чего в файле не осталось.
  const seen = Math.min(observedDays(file?.since ?? now, now), KEEP_DAYS)
  return { observedDays: seen, counts }
}

/**
 * Что можно выключить без потерь: дорогое и ни разу не сработавшее.
 *
 * Возвращает имена и общую цену — сам ничего не выключает. Решение остаётся за
 * человеком: у скилла может быть смысл, о котором счётчик не знает («нужен раз
 * в квартал, но тогда критично»).
 */
export function idleSkills(
  items: { name: string; tokens: number; state: string }[],
  counts: Record<string, number>
): { names: string[]; tokens: number } {
  const names: string[] = []
  let tokens = 0
  for (const s of items) {
    // Уже выключённые в счёт не идут: они ничего не стоят, и предлагать
    // выключить выключенное — шум.
    if (s.state === 'off') continue
    if (counts[s.name]) continue
    names.push(s.name)
    tokens += s.tokens > 0 ? s.tokens : 0
  }
  return { names, tokens }
}
