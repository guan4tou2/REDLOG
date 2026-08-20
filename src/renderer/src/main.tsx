import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './styles/index.css'
import { applyDensity, resolveDensity, storedDensity } from './lib/density'

// Apply the saved UI zoom and density before first paint so there's no visible
// resize on load. Settings ▸ 一般 lets them change both; this reads whatever
// they last chose. Zoom is clamped to [0.9, 1.5] to avoid unreadably tiny or
// offscreen. The default is 1 — it used to be 1.1 to compensate for text that
// was too small, which the 13px floor in the type scale now handles properly.
try {
  const raw = parseFloat(localStorage.getItem('redlog-app-zoom') || '')
  const zoom = Number.isFinite(raw) && raw >= 0.9 && raw <= 1.5 ? raw : 1
  document.body.style.setProperty('--app-zoom', String(zoom))
  applyDensity(resolveDensity(zoom, storedDensity()))
} catch { /* localStorage disabled — use CSS fallback */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
