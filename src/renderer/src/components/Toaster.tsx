/**
 * Bottom-right toast stack (DESIGN §5.4). Renders `store.toasts` — enqueued by the
 * reducer for `scriptError`/`error`/unexpected `sessionExited` (§5.4) or manually
 * via `pushToast`. Each toast can be dismissed by its `×` (`dismissToast`) and also
 * auto-dismisses after a timeout.
 *
 * Auto-dismiss lives in a child (`ToastItem`) so each toast owns exactly one timer
 * keyed to its stable id; mounting/unmounting the child starts/clears that timer
 * without a manual bookkeeping map.
 */

import { useEffect } from 'react'
import { useStore, type Toast } from '../store/store'
import { color } from '../style/tokens'

/** How long a toast stays before it auto-dismisses. */
const AUTO_DISMISS_MS = 6000

function ToastItem({
  toast,
  onDismiss
}: {
  toast: Toast
  onDismiss: (id: number) => void
}): React.JSX.Element {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), AUTO_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [toast.id, onDismiss])

  const isError = toast.kind === 'error'
  return (
    <div
      role={isError ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 4,
        maxWidth: 360,
        background: isError ? color.errorBg : color.infoBg,
        color: isError ? color.errorText : color.infoText,
        border: `1px solid ${isError ? color.errorBorder : color.infoBorder}`,
        boxShadow: '0 2px 8px rgba(0,0,0,0.15)'
      }}
    >
      <span style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {toast.message}
      </span>
      <span
        role="button"
        aria-label="dismiss"
        onClick={() => onDismiss(toast.id)}
        style={{ cursor: 'pointer' }}
      >
        ×
      </span>
    </div>
  )
}

export function Toaster(): React.JSX.Element {
  const toasts = useStore((s) => s.toasts)
  const dismissToast = useStore((s) => s.dismissToast)

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        zIndex: 200
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismissToast} />
      ))}
    </div>
  )
}
