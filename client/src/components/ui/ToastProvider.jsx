import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ToastContext } from './ToastContext.js'
import { Icon } from './Icon.jsx'

const DEFAULT_DURATION = 5000
const ERROR_DURATION = 8000

const ICONS = { info: 'info', success: 'checkCircle', error: 'alert' }

let nextId = 0

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef(new Map())

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
    const timer = timers.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(id)
    }
  }, [])

  const push = useCallback(
    (message, { type = 'info', duration = DEFAULT_DURATION } = {}) => {
      const id = (nextId += 1)
      setToasts((current) => [...current, { id, message, type, duration }])
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        )
      }
      return id
    },
    [dismiss]
  )

  useEffect(() => {
    // Captured now so cleanup does not read a ref that may have been replaced.
    const pending = timers.current
    return () => pending.forEach((timer) => clearTimeout(timer))
  }, [])

  const value = useMemo(
    () => ({
      push,
      dismiss,
      info: (message, options) => push(message, { ...options, type: 'info' }),
      success: (message, options) => push(message, { ...options, type: 'success' }),
      error: (message, options) =>
        push(message, { duration: ERROR_DURATION, ...options, type: 'error' }),
    }),
    [push, dismiss]
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className={'toast toast--' + toast.type}
            role={toast.type === 'error' ? 'alert' : 'status'}
          >
            <span className="toast__icon">
              <Icon name={ICONS[toast.type] || 'info'} size={16} />
            </span>

            <span className="toast__message">{toast.message}</span>

            <button
              type="button"
              className="toast__close"
              onClick={() => dismiss(toast.id)}
              aria-label="Dismiss notification"
            >
              &times;
            </button>

            {/* Drains for exactly the toast's lifetime, so its disappearance is
                predictable rather than abrupt. */}
            {toast.duration > 0 && (
              <span
                className="toast__timer"
                style={{ animationDuration: toast.duration + 'ms' }}
                aria-hidden="true"
              />
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
