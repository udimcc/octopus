/**
 * Top-right toast stack (DESIGN §5.4). Renders `store.toasts` — enqueued by the
 * reducer for `scriptError`/`error`/unexpected `sessionExited` (§5.4), the §9.5
 * status-change notification, or manually via `pushToast`. Each toast can be
 * dismissed by its `×` (`dismissToast`) and also auto-dismisses after a timeout.
 *
 * Auto-dismiss lives in a child (`ToastItem`) so each toast owns exactly one timer
 * keyed to its stable id; mounting/unmounting the child starts/clears that timer
 * without a manual bookkeeping map.
 */

import { useEffect } from 'react'
import { useStore, type Toast } from '../store/store'
import { color, radius, shadow } from '../style/tokens'

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
        gap: 10,
        padding: '10px 12px',
        borderRadius: radius.md,
        maxWidth: 360,
        background: isError ? color.errorBg : color.infoBg,
        color: isError ? color.errorText : color.infoText,
        border: `1px solid ${isError ? color.errorBorder : color.infoBorder}`,
        borderLeft: `3px solid ${isError ? color.errorText : color.infoText}`,
        boxShadow: shadow.lg
      }}
    >
      {!isError && <InfoIcon />}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {toast.title && (
          <span style={{ fontWeight: 700, wordBreak: 'break-word' }}>{toast.title}</span>
        )}
        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{toast.message}</span>
      </div>
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

/** A green circular "i" badge marking an info toast (left of the text). */
function InfoIcon(): React.JSX.Element {
  return (
    <span
      aria-hidden
      style={{
        flex: 'none',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 18,
        height: 18,
        marginTop: 1,
        borderRadius: '50%',
        background: color.successText,
        color: color.bgApp,
        fontSize: 12,
        fontWeight: 700,
        fontStyle: 'italic',
        lineHeight: 1
      }}
    >
      i
    </span>
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
        top: 16,
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
