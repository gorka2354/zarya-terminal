import ReactDOM from 'react-dom/client'
import App from './App'
// Fonts (bundled offline, cyrillic + latin subsets) — constructivist voice.
import '@fontsource/ruslan-display/cyrillic-400.css'
import '@fontsource/ruslan-display/latin-400.css'
import '@fontsource/oswald/cyrillic-300.css'
import '@fontsource/oswald/cyrillic-400.css'
import '@fontsource/oswald/cyrillic-500.css'
import '@fontsource/oswald/cyrillic-600.css'
import '@fontsource/oswald/latin-300.css'
import '@fontsource/oswald/latin-400.css'
import '@fontsource/oswald/latin-500.css'
import '@fontsource/oswald/latin-600.css'
import '@fontsource/pt-sans/cyrillic-400.css'
import '@fontsource/pt-sans/cyrillic-700.css'
import '@fontsource/pt-sans/latin-400.css'
import '@fontsource/pt-sans/latin-700.css'
// Pixel / dot-matrix voice: Pixelify Sans (logo, hero headings), Handjet (tech
// labels, bilingual sub-labels, telemetry gauges).
import '@fontsource/pixelify-sans/cyrillic-400.css'
import '@fontsource/pixelify-sans/cyrillic-500.css'
import '@fontsource/pixelify-sans/cyrillic-700.css'
import '@fontsource/pixelify-sans/latin-400.css'
import '@fontsource/pixelify-sans/latin-500.css'
import '@fontsource/pixelify-sans/latin-700.css'
import '@fontsource/handjet/cyrillic-400.css'
import '@fontsource/handjet/cyrillic-500.css'
import '@fontsource/handjet/latin-400.css'
import '@fontsource/handjet/latin-500.css'
import './styles/base.css'
import './styles/features.css'
import '@/features/themes/themePack'

// NB: no StrictMode — xterm.js instances are imperative singletons per session
// and StrictMode's double-mount in dev would duplicate terminal DOM/handlers.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
