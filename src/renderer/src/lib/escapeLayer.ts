// One Escape closes one layer. A modal dialog takes Escape in the capture
// phase and stops it (Modal.tsx is the model); a non-modal surface that
// listens on the window — the Timeline inspector, the replay drawer, the
// filter panel — asks this first and leaves an Escape that a layer above it
// has already answered, or that arrives while a modal dialog is open.
export function escapeBelongsAbove(e: KeyboardEvent): boolean {
  if (e.defaultPrevented) return true
  if (typeof document === 'undefined') return false
  return Array.from(document.querySelectorAll('[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')).some((dialog) => {
    for (let node: Element | null = dialog; node; node = node.parentElement) {
      if (node.hasAttribute('hidden') || node.hasAttribute('inert')) return false
      const style = getComputedStyle(node)
      if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
    }
    return true
  })
}
