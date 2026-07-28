import { createContext, useContext, useState, useCallback, ReactNode } from 'react'
import en from './en.json'
import zhTW from './zh-TW.json'

export type Locale = 'en' | 'zh-TW'

const locales: Record<Locale, Record<string, string>> = {
  'en': en,
  'zh-TW': zhTW
}

function detectLocale(): Locale {
  const stored = localStorage.getItem('redlog-locale') as Locale | null
  if (stored && locales[stored]) return stored
  const nav = navigator.language
  if (nav.startsWith('zh')) return 'zh-TW'
  return 'en'
}

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? `{{${key}}}`))
}

interface I18nContextValue {
  locale: Locale
  setLocale: (l: Locale) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue>(null!)

export function I18nProvider({ children }: { children: ReactNode }): JSX.Element {
  const [locale, setLocaleState] = useState<Locale>(detectLocale)

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    localStorage.setItem('redlog-locale', l)
  }, [])

  const t = useCallback((key: string, vars?: Record<string, string | number>): string => {
    const str = locales[locale]?.[key] ?? locales['en'][key] ?? key
    return interpolate(str, vars)
  }, [locale])

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
