# Themes

Zarya ships one theme language — light with a direction and a time of day — voiced
in eleven keys, from the blue hour before sunrise to noon. A theme is a plain `ThemeDef`
(`src/shared/types.ts`) with two colour groups: `ui` (`ThemeUiColors` — the app
chrome: backgrounds, borders, foreground, accents, status colours) and `terminal`
(`ThemeTerminalColors` — the full 16-colour ANSI palette plus background, foreground,
cursor and selection for xterm).

## The collection

Seven dark themes and four light ones, read as hours of light rather than as a list
of unrelated moods. Identifiers are unchanged from the era they were named in — a
rename must never cost anyone the theme they picked.

| id | Name | Type | Feel / intended use |
|---|---|---|---|
| `zarya-blue-hour` | Zarya · Blue Hour | dark | **Default.** Twenty minutes before sunrise: cold ground, one warm signal. |
| `zarya-cosmos` | Zarya · Night | dark | Deep graphite, the darkest of the set. |
| `zarya-vostok` | Zarya · Embers | dark | Red-dominant, banked coals. |
| `zarya-orbita` | Zarya · Frost | dark | Teal control-panel / oscilloscope retrofuturism. |
| `zarya-dawn` | Zarya · First Ray | dark | The original sunrise theme, kept as a warm orange option. |
| `zarya-sputnik` | Zarya · Ash | dark | Cold graphite, muted brass telemetry. |
| `zarya-baikonur` | Zarya · Sand | dark | Warm amber over a dark steppe. |
| `zarya-golden-hour` | Zarya · Golden Hour | light | Morning on paper: warm ground, burnt-ochre signal. |
| `zarya-plakat` | Zarya · Paper | light | Cream paper, red + black ink. |
| `zarya-polden` | Zarya · Noon | light | Warm daylight, red + brass. |
| `zarya-chertyozh` | Zarya · Tracing | light | Technical drawing on cool paper — navy lines + red notes. |

The base four (`cosmos`, `vostok`, `orbita`, `dawn`) live in
`src/renderer/src/features/themes/themes.ts`; the extended pack (`sputnik`,
`baikonur`, `plakat`, `polden`, `chertyozh`) in `themePack.ts`; the dawn pair in
`themeDawn.ts`. Both packs register on import — from `src/renderer/src/main.tsx`,
not from the gallery: the gallery loads later than `App` applies the saved theme,
and a theme that is not registered yet is silently replaced by the default.

**A theme is only finished when its two signals cannot be confused.** The accent
means "Enter lands here"; `danger` means the opposite. `tests/themeSignals.test.ts`
checks the dawn pair by numbers — contrast ≥ 1.5 and ≥ 30° of hue between them,
each ≥ 4.5:1 against its own ground, ANSI blue still blue. For reference, in the
old Kosmos palette those two colours sat 1.25 apart with **one** degree of hue
between them.

Light themes deliberately carry **darkened, saturated** ANSI palettes so terminal
text stays legible on cream/paper backgrounds.

## Switching themes

Open Settings (`Ctrl+,`), go to the **Appearance** tab, and
pick a card under **Theme**. Each card shows the theme's
background / accent / accent-2 swatches, its name, and a `DARK` /
`LIGHT` tag; the active one is marked `● ACTIVE`. Clicking a card writes
`appearance.themeId` to settings (persisted in `settings.json`) and applies it live.

Under the hood, `applyTheme(theme)` (`themes.ts`):

- maps each `ThemeUiColors` field to a CSS custom property on `<html>` (`--bg`,
  `--accent`, `--accent-grad`, `--danger`, …) via `VAR_MAP`,
- keeps the native window backing (`body.backgroundColor`) and `--term-bg` in sync so
  there's no dark flash under a light theme,
- stamps `documentElement.dataset.theme` / `dataset.themeType` — the latter drives the
  light-theme overrides in `base.css` (soft shadows, and no glow under the window:
  the dawn ground is a dark-theme device only),
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
   const myTheme: ThemeDef = { id: 'zarya-mir', nameKey: 'theme.mir', type: 'dark', ui: { … }, terminal: { … } }
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
