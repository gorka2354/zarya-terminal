# Themes

Zarya ships a single cosmic-constructivist theme language — Soviet space programme +
constructivism — voiced in nine keys. A theme is a plain `ThemeDef`
(`src/shared/types.ts`) with two colour groups: `ui` (`ThemeUiColors` — the app
chrome: backgrounds, borders, foreground, accents, status colours) and `terminal`
(`ThemeTerminalColors` — the full 16-colour ANSI palette plus background, foreground,
cursor and selection for xterm).

## The collection

Six dark themes and three light "poster paper" themes. They're listed here in the
order they appear in the picker (base themes first, then the extended pack):

| id | Name | Type | Feel / intended use |
|---|---|---|---|
| `zarya-cosmos` | Заря · Космос | dark | **Default.** Signature deep-space navy, brand red, brass gold. |
| `zarya-vostok` | Заря · Восток | dark | Red-dominant, deep maroon space. |
| `zarya-orbita` | Заря · Орбита | dark | Teal control-panel / oscilloscope retrofuturism. |
| `zarya-dawn` | Заря · Рассвет | dark | The original sunrise theme, kept as a warm orange option. |
| `zarya-sputnik` | Заря · Спутник | dark | Cold graphite hull, brand red, brass telemetry. |
| `zarya-baikonur` | Заря · Байконур | dark | Warm steppe night, sodium launch-pad amber. |
| `zarya-plakat` | Заря · Плакат | light | Constructivist poster: cream paper, red + black ink. |
| `zarya-polden` | Заря · Полдень | light | Warm cosmonaut daylight, red + brass. |
| `zarya-chertyozh` | Заря · Чертёж | light | Technical drawing on cool paper — navy lines + red notes. |

The base four (`cosmos`, `vostok`, `orbita`, `dawn`) live in
`src/renderer/src/features/themes/themes.ts`; the extended pack (`sputnik`,
`baikonur`, `plakat`, `polden`, `chertyozh`) in `themePack.ts`, which registers
itself on import (imported for its side effect in `src/renderer/src/main.tsx`).

Light themes deliberately carry **darkened, saturated** ANSI palettes so terminal
text stays legible on cream/paper backgrounds.

## Switching themes

Open Settings — **"Центр управления"** — (`Ctrl+,`), go to the **Внешний вид**
(Appearance) tab, and pick a card under **Тема**. Each card shows the theme's
background / accent / accent-2 swatches, its name, and a `ТЁМНАЯ · DARK` /
`СВЕТЛАЯ · LIGHT` tag; the active one is marked `● АКТИВНА`. Clicking a card writes
`appearance.themeId` to settings (persisted in `settings.json`) and applies it live.

Under the hood, `applyTheme(theme)` (`themes.ts`):

- maps each `ThemeUiColors` field to a CSS custom property on `<html>` (`--bg`,
  `--accent`, `--accent-grad`, `--danger`, …) via `VAR_MAP`,
- keeps the native window backing (`body.backgroundColor`) and `--term-bg` in sync so
  there's no dark flash under a light theme,
- stamps `documentElement.dataset.theme` / `dataset.themeType` — the latter is what
  the star backdrop reads to invert to dark stars on light themes,
- and hands the terminal palette to xterm through `toXtermTheme(theme)` (the
  `terminal` colours plus a derived `cursorAccent`).

## Adding your own theme

1. **Define a `ThemeDef`.** Give it a unique `id`, a `name`, a `type`
   (`'dark' | 'light'`), and fill in **every** field of `ui` (`ThemeUiColors`) and
   `terminal` (`ThemeTerminalColors`) — the ANSI palette needs all 16 named colours
   plus `background` / `foreground` / `cursor` / `selectionBackground`. Copy an
   existing theme as a starting point. For a light theme, darken/saturate the ANSI
   colours so text stays readable on the paper background.

2. **Register it.** Either add it to the base `registry` array in `themes.ts`, or —
   the cleaner path for extra themes — append it to the `registerThemes([...])` call
   at the bottom of `themePack.ts`:

   ```ts
   const myTheme: ThemeDef = { id: 'zarya-mir', name: 'Заря · Мир', type: 'dark', ui: { … }, terminal: { … } }
   registerThemes([myTheme])
   ```

   `registerThemes()` de-dupes by `id` (a second theme with an id already present is
   ignored), and `getThemes()` — what the picker renders — returns the live registry,
   so a newly registered theme shows up in the Appearance grid automatically.

3. **Preview it without the screen.** The offscreen QA harness can boot straight into
   any theme and screenshot the real renderer (see
   [docs/architecture.md](architecture.md)):

   ```
   node scripts/shoot.mjs --theme zarya-mir --out shots/mir.png
   ```
