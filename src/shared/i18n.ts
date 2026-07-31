import type { UiLang } from './types'

/**
 * Словарь интерфейса.
 *
 * Ключи ИМЕНОВАННЫЕ, а не «русская фраза как ключ». Фраза в роли ключа
 * ломается от любой правки текста, и тогда часть интерфейса молча возвращается
 * к чужому языку — заметить это можно только глазами и только случайно.
 *
 * Английский — не подстрочник. «Борт готов к старту» — это «Ready for launch»,
 * а не «Board is ready for the start»: смысл важнее буквы, тон сохраняется.
 * Космическая эстетика переводится, а не вычищается: ORBIT-1 и CREW — это лицо
 * продукта, а не помеха для чужого языка.
 *
 * Что НЕ переводится: имена движков (Claude Code, Codex), пути, вывод оболочки
 * и ответы агента — это данные, а не интерфейс.
 */
export type Dict = Record<string, string>

/** Русский — исходный: на нём написан продукт и на нём работает владелец. */
export const RU: Dict = {
  // --- шапка окна
  'title.tagline': '// ОРБИТА-1',
  'title.logoHint': 'Заря · ОРБИТА-1 — космический CLI-агент',
  'title.projects': 'проекты',
  'title.projectsHint': 'Клик — проекты и папки',
  'title.noFolder': 'Папка не выбрана',
  'title.theme': 'ТЕМА',
  'title.themeHint': 'Сменить тему борта',
  'title.minimize': 'Свернуть',
  'title.maximize': 'Развернуть',
  'title.restore': 'Восстановить',
  'title.close': 'Закрыть',

  // --- сайдбар
  'sidebar.sessions': 'Сессии',
  'sidebar.search': 'Поиск сессий…',
  'sidebar.open': 'Открытые',
  'sidebar.favorites': 'Избранные',
  'sidebar.recent': 'Недавние',
  'sidebar.crew': 'Экипаж · агенты',
  'sidebar.crewIdle': 'Борт-инженер / готов',
  'sidebar.crewBusy': 'выполняется',
  'sidebar.newTerminal': 'Новый терминал (Ctrl+Shift+T)',
  'sidebar.moreMenu': 'Открыть в папке / проект / недавние…',
  'sidebar.empty':
    'Открой новый терминал кнопкой + в заголовке (Ctrl+Shift+T).\n\nСессии переживают перезапуск и выключение — закрытые появятся здесь для восстановления.',

  // --- рабочий стол и панели
  'desk.rename': 'Рабочий стол · 2×клик — переименовать',
  'desk.renamePrompt': 'Название рабочего стола (пусто — по панелям)',
  'desk.renameBtn': 'Переименовать рабочий стол',
  'desk.closeAll': 'Закрыть весь рабочий стол',
  'desk.untitled': 'Терминал',
  'pane.focused': 'Панель в фокусе — сюда уходят Enter и Esc',
  'pane.clickToFocus': 'Клик — сделать активной · 2×клик — на всю вкладку',
  'pane.hiddenByMax': 'Сейчас не видно — развёрнута другая панель. Клик — показать эту',
  'pane.activeHint': 'Активная панель — сюда уходят Enter и Esc',
  'pane.maximize': 'Развернуть на всю вкладку',
  'pane.restore': 'Свернуть к раскладке',
  'pane.detach': 'Вынести в отдельную вкладку',
  'pane.detachHint': 'или перетащи в список',
  'pane.detachHintHeader': 'или перетащи шапку в список',
  'pane.detached': 'Панель вынесена в отдельную вкладку',
  'pane.close': 'Закрыть панель',
  'pane.closeTab': 'Закрыть терминал',
  'pane.closeWhole': 'Закрыть терминал целиком',
  'pane.splitRight': 'Разделить вправо',
  'pane.splitDown': 'Разделить вниз',
  'pane.openBeside': 'Открыть панель рядом',
  'pane.grip': 'Перетащи: на другую панель — перенести, в список слева — вынести в отдельную вкладку',
  'pane.tabClickHint': 'Клик — открыть этот рабочий стол · 2×клик — переименовать',
  'pane.tabDropHint': 'Бросьте сюда панель, чтобы перенести её в этот стол',
  'pane.maximized': 'во весь экран',
  'pane.dropZoneTitle': '↩ вернуть в список',
  'pane.dropZoneSub':
    'отпусти здесь — панель уедет из сетки отдельной вкладкой, процесс не прервётся',
  'pane.tooMany': 'В одной вкладке не больше {n} панелей — открыл новой вкладкой',
  'pane.tabFull': 'В этой вкладке уже {n} панели — больше не влезет',

  // --- закрытие с потерями
  'close.paneQuestion': 'Закрыть панель?',
  'close.tabQuestion': 'Закрыть терминал целиком ({n} панели)?',
  'close.willLose': 'Пропадёт:',
  'close.draft': 'неотправленный текст: «{text}»',
  'close.gate': 'агент ждёт решения по инструменту — оно будет отклонено',
  'close.streaming': 'агент выполняет ход — он будет прерван',
  'close.images': 'вложений: {n}',
  'close.queued': 'приписка в очереди: «{text}»',

  // --- лента
  'feed.ready': 'готов · введите запрос в строку ниже ↓',
  'feed.agentAnswer': 'ОТВЕТ АГЕНТА',
  'feed.typing': 'агент отвечает…',
  'feed.queued': 'в очереди: {text}',
  'feed.queuedHint': '↑ или Esc — вернуть в строку',
  'feed.heroTitle': 'Борт готов к старту',
  'feed.heroSub': 'введите команду или запрос агенту в строку ниже ↓',
  'feed.launchAgent': 'ЗАПУСТИТЬ ИИ-АГЕНТА В ТЕРМИНАЛЕ',
  'feed.recentClaude': 'НЕДАВНИЕ СЕССИИ CLAUDE В ЭТОЙ ПАПКЕ',
  'feed.noPastSessions': 'Нет прошлых сессий Claude в этой папке',
  'feed.toBlocks': 'Вернуться к блокам (Warp-фид)',
  'feed.findInTerminal': 'Найти в терминале',
  'feed.approve': 'ВЫПОЛНИТЬ',
  'feed.deny': 'ОТКЛОНИТЬ',
  'feed.wantsToRun': 'агент хочет выполнить',
  'feed.wantsToRead': 'агент хочет прочитать',
  'feed.wantsToEdit': 'агент хочет изменить файл',
  'feed.denied': 'отклонено оператором',
  'feed.done': 'готово',

  // --- строка ввода
  'bar.placeholderShell': 'Команда терминала…  (Enter — выполнить)',
  'bar.placeholderZarya': 'Спросить агента Zarya…  (Enter)',
  'bar.placeholderClaude': 'Спросить Claude Code…  (Enter, нативно, подписка Max)',
  'bar.placeholderCodex': 'Спросить Codex…  (Enter, нативно)',
  'bar.placeholderGemini': 'Спросить Gemini…  (Enter, нативно)',
  'bar.placeholderKimi': 'Спросить Kimi…  (Enter, нативно)',
  'bar.placeholderQwen': 'Спросить Qwen…  (Enter, нативно)',
  'bar.busy': 'Агент работает — Enter поставит в очередь · Esc прервать · ↑ править',
  'bar.send': 'Отправить агенту (Enter)',
  'bar.run': 'Выполнить команду (Enter)',
  'bar.modeTerminal': 'ТЕРМИНАЛ',
  'bar.dictate': 'Диктовка',
  'bar.micBusy': 'Микрофон занят другой панелью — закончи запись там',
  'bar.recording': 'Идёт запись — нажми, чтобы закончить (Esc — отменить)',
  'bar.autopilotOn': '⚠ АВТОПИЛОТ — борт выполняет инструменты сам, без подтверждений',
  'bar.autopilotOff': 'Ручное управление — борт спрашивает подтверждение перед инструментами',

  // --- нижняя полоса
  'strip.pending': 'ЖДУТ РЕШЕНИЯ: {n}',
  'strip.fueled': 'борт заправлен',
  'strip.noLimit': '∞ без лимита · локальный борт',
  'strip.console': 'пульт ▴',
  'strip.saved': 'сохранено · только что',

  // --- проекты
  'projects.section': 'ПРОЕКТЫ',
  'projects.clickHint': 'клик — вкладкой',
  'projects.openFolder': 'Открыть папку…',
  'projects.add': 'Добавить папку в проекты…',
  'projects.openBeside': 'Открыть панелью рядом · {path}\nИли перетащи проект на нужную панель',
  'projects.remove': 'Убрать «{name}» из проектов',
  'projects.newTerminal': 'Новый терминал',
  'projects.newPaneIn': 'Новая панель в папке…',
  'projects.recentFolders': 'НЕДАВНИЕ ПАПКИ',

  'brand': 'ЗАРЯ',
  'session.pinned': 'Закреплена',
  'settings.theme': 'Тема',
  'sidebar.blocks': '{n} блоков',
  'sidebar.openBadge': 'открыта',
  'pane.dblclick': '2×клик',
  'projects.openIn': 'Открыть терминал в {dir}',
  'projects.openHere': 'Открыть терминал здесь',
  'projects.showInExplorer': 'Открыть в проводнике',
  'projects.removeShort': 'Убрать из проектов',
  'tab.closeOthers': 'Закрыть другие вкладки',
  'tab.close': 'Закрыть вкладку',
  'splash': 'Заря · подготовка к старту',
  'workspace.empty': 'Открой терминал кнопкой + в сайдбаре (Ctrl+Shift+T)',
  'workspace.openedIn': 'Терминал в {dir}',
  'ide.open': 'Открыть IDE-агента (второй пилот · свой ключ)',
  'ide.label': 'IDE-АГЕНТ',

  // --- общее
  'common.rename': 'Переименовать…',
  'common.sessionName': 'Название сессии',
  'common.favoriteAdd': 'В избранное',
  'common.favoriteRemove': 'Убрать из избранного',
  'common.pin': 'Закрепить (защита от очистки)',
  'common.unpin': 'Открепить',
  'common.copy': 'Копировать',
  'common.paste': 'Вставить',
  'common.clear': 'Очистить',
  'common.open': 'Открыть',
  'common.delete': 'Удалить сессию',
  'common.deleteAsk': 'Удалить сохранённую сессию «{name}»?',
  'common.settings': 'Центр управления',
  'common.language': 'Язык интерфейса',
  'common.langAuto': 'Как в системе',
  'common.langRu': 'Русский',
  'common.langEn': 'English'
}

/**
 * Английский. Тон тот же: коротко, по делу, с космической рамкой — но без
 * буквализма. «Борт заправлен» — это «tanks full», а не «the board is fueled».
 */
export const EN: Dict = {
  'title.tagline': '// ORBIT-1',
  'title.logoHint': 'Zarya · ORBIT-1 — a space-age CLI agent',
  'title.projects': 'projects',
  'title.projectsHint': 'Click for projects and folders',
  'title.noFolder': 'No folder selected',
  'title.theme': 'THEME',
  'title.themeHint': 'Switch the ship theme',
  'title.minimize': 'Minimize',
  'title.maximize': 'Maximize',
  'title.restore': 'Restore',
  'title.close': 'Close',

  'sidebar.sessions': 'Sessions',
  'sidebar.search': 'Search sessions…',
  'sidebar.open': 'Open',
  'sidebar.favorites': 'Favorites',
  'sidebar.recent': 'Recent',
  'sidebar.crew': 'Crew · agents',
  'sidebar.crewIdle': 'Flight engineer / ready',
  'sidebar.crewBusy': 'working',
  'sidebar.newTerminal': 'New terminal (Ctrl+Shift+T)',
  'sidebar.moreMenu': 'Open in folder / project / recent…',
  'sidebar.empty':
    'Open a terminal with + in the header (Ctrl+Shift+T).\n\nSessions survive restarts and shutdowns — closed ones show up here, ready to restore.',

  'desk.rename': 'Desk · double-click to rename',
  'desk.renamePrompt': 'Desk name (empty — name it after the panes)',
  'desk.renameBtn': 'Rename desk',
  'desk.closeAll': 'Close the whole desk',
  'desk.untitled': 'Terminal',
  'pane.focused': 'Focused pane — Enter and Esc land here',
  'pane.clickToFocus': 'Click to focus · double-click to fill the desk',
  'pane.hiddenByMax': 'Hidden — another pane fills the desk. Click to show this one',
  'pane.activeHint': 'Active pane — Enter and Esc land here',
  'pane.maximize': 'Fill the desk',
  'pane.restore': 'Back to the layout',
  'pane.detach': 'Move to its own desk',
  'pane.detachHint': 'or drag it into the list',
  'pane.detachHintHeader': 'or drag the header into the list',
  'pane.detached': 'Pane moved to its own desk',
  'pane.close': 'Close pane',
  'pane.closeTab': 'Close terminal',
  'pane.closeWhole': 'Close the whole desk',
  'pane.splitRight': 'Split right',
  'pane.splitDown': 'Split down',
  'pane.openBeside': 'Open a pane beside',
  'pane.grip': 'Drag: onto another pane to move it, into the list on the left to give it its own desk',
  'pane.tabClickHint': 'Click to open this desk · double-click to rename',
  'pane.tabDropHint': 'Drop a pane here to move it into this desk',
  'pane.maximized': 'full desk',
  'pane.dropZoneTitle': '↩ back to the list',
  'pane.dropZoneSub': 'drop here — the pane leaves the grid for its own desk, the process keeps running',
  'pane.tooMany': 'A desk holds at most {n} panes — opened a new desk instead',
  'pane.tabFull': 'This desk already holds {n} panes',

  'close.paneQuestion': 'Close this pane?',
  'close.tabQuestion': 'Close the whole desk ({n} panes)?',
  'close.willLose': 'You will lose:',
  'close.draft': 'unsent text: “{text}”',
  'close.gate': 'the agent is waiting for a decision — it will be denied',
  'close.streaming': 'the agent is mid-turn — it will be interrupted',
  'close.images': 'attachments: {n}',
  'close.queued': 'queued message: “{text}”',

  'feed.ready': 'ready · type a command or a request below ↓',
  'feed.agentAnswer': 'AGENT REPLY',
  'feed.typing': 'agent is typing…',
  'feed.queued': 'queued: {text}',
  'feed.queuedHint': '↑ or Esc to take it back',
  'feed.heroTitle': 'Ready for launch',
  'feed.heroSub': 'type a command or ask the agent below ↓',
  'feed.launchAgent': 'LAUNCH AN AI AGENT IN THIS TERMINAL',
  'feed.recentClaude': 'RECENT CLAUDE SESSIONS IN THIS FOLDER',
  'feed.noPastSessions': 'No past Claude sessions in this folder',
  'feed.toBlocks': 'Back to blocks (Warp feed)',
  'feed.findInTerminal': 'Find in terminal',
  'feed.approve': 'RUN',
  'feed.deny': 'DENY',
  'feed.wantsToRun': 'the agent wants to run',
  'feed.wantsToRead': 'the agent wants to read',
  'feed.wantsToEdit': 'the agent wants to edit a file',
  'feed.denied': 'denied by the operator',
  'feed.done': 'done',

  'bar.placeholderShell': 'Terminal command…  (Enter to run)',
  'bar.placeholderZarya': 'Ask the Zarya agent…  (Enter)',
  'bar.placeholderClaude': 'Ask Claude Code…  (Enter, native, Max plan)',
  'bar.placeholderCodex': 'Ask Codex…  (Enter, native)',
  'bar.placeholderGemini': 'Ask Gemini…  (Enter, native)',
  'bar.placeholderKimi': 'Ask Kimi…  (Enter, native)',
  'bar.placeholderQwen': 'Ask Qwen…  (Enter, native)',
  'bar.busy': 'Agent is working — Enter queues · Esc interrupts · ↑ edits',
  'bar.send': 'Send to the agent (Enter)',
  'bar.run': 'Run the command (Enter)',
  'bar.modeTerminal': 'TERMINAL',
  'bar.dictate': 'Dictation',
  'bar.micBusy': 'The microphone is busy in another pane — finish there first',
  'bar.recording': 'Recording — click to finish (Esc to cancel)',
  'bar.autopilotOn': '⚠ AUTOPILOT — tools run without asking you',
  'bar.autopilotOff': 'Manual control — you are asked before every tool',

  'strip.pending': 'AWAITING DECISION: {n}',
  'strip.fueled': 'tanks full',
  'strip.noLimit': '∞ no limit · local engine',
  'strip.console': 'console ▴',
  'strip.saved': 'saved · just now',

  'projects.section': 'PROJECTS',
  'projects.clickHint': 'click opens a desk',
  'projects.openFolder': 'Open folder…',
  'projects.add': 'Add a folder to projects…',
  'projects.openBeside': 'Open as a pane beside · {path}\nOr drag the project onto the pane you want',
  'projects.remove': 'Remove “{name}” from projects',
  'projects.newTerminal': 'New terminal',
  'projects.newPaneIn': 'New pane in folder…',
  'projects.recentFolders': 'RECENT FOLDERS',

  'brand': 'ZARYA',
  'session.pinned': 'Pinned',
  'settings.theme': 'Theme',
  'sidebar.blocks': '{n} blocks',
  'sidebar.openBadge': 'open',
  'pane.dblclick': 'double-click',
  'projects.openIn': 'Open a terminal in {dir}',
  'projects.openHere': 'Open a terminal here',
  'projects.showInExplorer': 'Reveal in file manager',
  'projects.removeShort': 'Remove from projects',
  'tab.closeOthers': 'Close other desks',
  'tab.close': 'Close desk',
  'splash': 'Zarya · preparing for launch',
  'workspace.empty': 'Open a terminal with + in the sidebar (Ctrl+Shift+T)',
  'workspace.openedIn': 'Terminal in {dir}',
  'ide.open': 'Open the IDE agent (second pilot · your own key)',
  'ide.label': 'IDE AGENT',

  'common.rename': 'Rename…',
  'common.sessionName': 'Session name',
  'common.favoriteAdd': 'Add to favorites',
  'common.favoriteRemove': 'Remove from favorites',
  'common.pin': 'Pin (protect from cleanup)',
  'common.unpin': 'Unpin',
  'common.copy': 'Copy',
  'common.paste': 'Paste',
  'common.clear': 'Clear',
  'common.open': 'Open',
  'common.delete': 'Delete session',
  'common.deleteAsk': 'Delete the saved session “{name}”?',
  'common.settings': 'Mission Control',
  'common.language': 'Interface language',
  'common.langAuto': 'Match the system',
  'common.langRu': 'Русский',
  'common.langEn': 'English'
}

const DICTS: Record<Exclude<UiLang, 'auto'>, Dict> = { ru: RU, en: EN }

/** Язык системы → наш. Всё, что не русское, получает английский. */
export function resolveLang(setting: UiLang, systemLang: string): Exclude<UiLang, 'auto'> {
  if (setting !== 'auto') return setting
  return /^ru\b/i.test(systemLang) ? 'ru' : 'en'
}

/**
 * Строка на выбранном языке. Подстановки — `{name}`.
 *
 * Пропущенный ключ возвращает САМ КЛЮЧ, а не пустоту: пустое место в интерфейсе
 * никто не заметит, а `pane.close` посреди меню виден сразу — и чинится сразу.
 */
export function translate(
  lang: Exclude<UiLang, 'auto'>,
  key: string,
  vars?: Record<string, string | number>
): string {
  const dict = DICTS[lang] ?? EN
  const raw = dict[key] ?? RU[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m))
}

/** Ключи, которых не хватает во втором словаре — для прогона полноты. */
export function missingKeys(): { inEn: string[]; inRu: string[] } {
  return {
    inEn: Object.keys(RU).filter((k) => !(k in EN)),
    inRu: Object.keys(EN).filter((k) => !(k in RU))
  }
}
