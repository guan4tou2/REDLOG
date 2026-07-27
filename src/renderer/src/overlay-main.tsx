import React from 'react'
import ReactDOM from 'react-dom/client'
import OverlayApp from './OverlayApp'
import { I18nProvider } from './i18n'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <OverlayApp />
    </I18nProvider>
  </React.StrictMode>
)
