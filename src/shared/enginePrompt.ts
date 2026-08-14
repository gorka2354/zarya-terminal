/**
 * Приписка к системному промпту движка: что к ней добавляет сама Заря.
 *
 * ПОВОД. inc-35 выяснил живьём: увести УЖЕ ИДУЩУЮ команду оболочки в фон
 * движок не умеет — отвечает «увёл» и продолжает её ждать. Зато запустить
 * команду в фоне СРАЗУ он умеет прекрасно (`run_in_background` у Bash,
 * проверено). Значит единственный рычаг человека — попросить агента делать так
 * с самого начала, и просьба эта живёт в системном промпте.
 *
 * ЭТО ПРОСЬБА, А НЕ ГАРАНТИЯ, и настройка обязана называть себя именно так.
 * Решение остаётся за моделью: она может счесть команду короткой и запустить её
 * обычным способом. Тумблер с обещанием «все долгие команды уйдут в фон» был бы
 * враньём о чужом поведении.
 *
 * Чистой функцией, потому что здесь легко испортить чужое: текст человека —
 * его собственная приписка к промпту агента, и потерять её, дописывая своё,
 * значит молча отменить то, что он настраивал руками.
 */

/**
 * По-английски намеренно. Это не интерфейс, а данные для модели: движок
 * разговаривает с собой по-английски, и промпт — его язык, а не наш.
 */
const BACKGROUND_HINT = [
  'Long-running shell commands — builds, test suites, dev servers, watchers,',
  'anything you expect to take more than about 30 seconds — must be started with',
  "the Bash tool's `run_in_background: true`. Then continue the conversation and",
  'collect the result later with BashOutput instead of blocking the turn. Short',
  'commands stay in the foreground as usual.'
].join(' ')

/**
 * СОСЕДНИЕ ПАНЕЛИ — про них надо НАПОМНИТЬ, а не только дать инструмент.
 *
 * Живой прогон показал ровно это: на вопрос про чужой проект агент искал в
 * своей папке, не нашёл и попросил путь — про соседнюю панель не вспомнил ни
 * разу. Описание инструмента модель читает, когда УЖЕ решила им
 * воспользоваться; чтобы она вспомнила о соседях сама, сказать надо в промпте.
 *
 * Едет только при включённых записках: платить за эту строку в каждом запросе
 * там, где инструментов нет вовсе, было бы враньём о цене.
 */
const PANES_HINT = [
  'Other Zarya panes may be open on this machine, each working in its own folder',
  'and on its own task. When a question is about another project, or clearly',
  "outside this pane's folder, do not guess and do not go hunting elsewhere on",
  'disk: call mcp__zarya__list_panes, see which pane that work belongs to, and',
  'tell the person which pane knows — offering to ask it for them. Ask it',
  'directly when they say so.'
].join(' ')

/**
 * Итоговая приписка: наши просьбы плюс текст человека.
 *
 * Порядок такой: сначала наше, потом его. Приписка человека идёт последней
 * намеренно — при споре двух указаний ближе к концу промпта то, что он написал
 * сам, и оно должно перевешивать нашу заготовку.
 */
export function enginePromptAppend(
  userText: string,
  backgroundLongCommands: boolean,
  paneMessages = false
): string {
  const mine = [backgroundLongCommands ? BACKGROUND_HINT : '', paneMessages ? PANES_HINT : '']
    .filter(Boolean)
    .join('\n\n')
  const theirs = (userText ?? '').trim()
  if (!mine) return theirs
  if (!theirs) return mine
  return `${mine}\n\n${theirs}`
}
