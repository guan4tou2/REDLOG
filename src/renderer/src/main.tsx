import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './styles/index.css'

// Apply user's saved UI zoom before first paint so there's no visible resize
// on load. Settings ▸ 一般 lets them change it; this reads whatever they
// last chose. Clamped to [0.9, 1.5] to avoid unreadably tiny or offscreen.
try {
  const raw = parseFloat(localStorage.getItem('redlog-app-zoom') || '')
  const zoom = Number.isFinite(raw) && raw >= 0.9 && raw <= 1.5 ? raw : 1.1
  document.body.style.setProperty('--app-zoom', String(zoom))
} catch { /* localStorage disabled — use CSS fallback */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
