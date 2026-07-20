import ReactDOM from 'react-dom/client'
import App from './App'
import './styles/base.css'
import './styles/features.css'
import '@/features/themes/themePack'

// NB: no StrictMode — xterm.js instances are imperative singletons per session
// and StrictMode's double-mount in dev would duplicate terminal DOM/handlers.
ReactDOM.createRoot(document.getElementById('root')!).render(<App />)
