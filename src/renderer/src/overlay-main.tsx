import React from 'react'
import ReactDOM from 'react-dom/client'
import OverlayApp from './OverlayApp'
import { I18nProvider } from './i18n'
import './styles/fonts'

// A file dropped outside a drop zone would otherwise make the browser open it,
// navigating away from the app. Only the default action is cancelled; React
// handlers on a real drop zone still run.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault())

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <OverlayApp />
    </I18nProvider>
  </React.StrictMode>
)
