import { useState, useEffect, useCallback } from 'react'

interface ToastItem {
  id: number
  message: string
  type: 'scope' | 'loot' | 'info'
}

const TOAST_COLORS = {
  scope: { bg: 'bg-red-900/90', border: 'border-red-500', icon: '⊘' },
  loot: { bg: 'bg-yellow-900/90', border: 'border-yellow-500', icon: '◆' },
  info: { bg: 'bg-zinc-800/90', border: 'border-zinc-500', icon: '●' }
}

let nextId = 0

export function useToast(): { toasts: ToastItem[]; addToast: (message: string, type: ToastItem['type']) => void } {
  const [toasts, setToasts] = useState<ToastItem[]>([])

  const addToast = useCallback((message: string, type: ToastItem['type']) => {
    const id = nextId++
    setToasts((prev) => [...prev.slice(-4), { id, message, type }])
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000)
  }, [])

  return { toasts, addToast }
}

export default function ToastContainer({ toasts }: { toasts: ToastItem[] }): JSX.Element {
  return (
    <div className="fixed bottom-8 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <ToastNotification key={t.id} toast={t} />
      ))}
    </div>
  )
}

function ToastNotification({ toast }: { toast: ToastItem }): JSX.Element {
  const [visible, setVisible] = useState(false)
  const s = TOAST_COLORS[toast.type]

  useEffect(() => {
    requestAnimationFrame(() => setVisible(true))
    const timer = setTimeout(() => setVisible(false), 4500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div
      className={`${s.bg} border ${s.border} rounded-lg px-3 py-2 text-xs font-mono text-white shadow-lg backdrop-blur-sm transition-all duration-300 ${
        visible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4'
      }`}
    >
      <span className="mr-2">{s.icon}</span>
      {toast.message}
    </div>
  )
}
