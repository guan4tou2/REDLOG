import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { I18nProvider } from './i18n'
import './styles/fonts'
import './styles/index.css'
import { applyDensity, resolveDensity, storedDensity } from './lib/density'
import { UI_SCALE_KEY, parseUiScale, zoomFor } from './lib/uiScale'

// Apply the saved UI zoom and density before first paint so there's no visible
// resize on load. Settings ▸ 一般 lets them change both; this reads whatever
// they last chose, and falls back to the default in lib/uiScale.
try {
  const scale = parseUiScale(localStorage.getItem(UI_SCALE_KEY))
  document.body.style.setProperty('--app-zoom', String(zoomFor(scale)))
  // The scale, not the zoom: density is decided on the number the operator
  // chose, which is the same one the settings page compares.
  applyDensity(resolveDensity(scale, storedDensity()))
} catch { /* localStorage disabled — index.css carries the same default */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
)
