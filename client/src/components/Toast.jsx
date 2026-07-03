import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { CheckIcon, ErrorIcon, InfoIcon } from './icons.jsx';

const ToastContext = createContext(null);

const ICONS = {
  success: CheckIcon,
  error: ErrorIcon,
  info: InfoIcon
};

let sequence = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (toast) => {
      const id = (sequence += 1);
      const type = toast.type || 'info';
      // Errors stay until dismissed so the detail can be read; others fade.
      const duration = toast.duration ?? (type === 'error' ? 0 : 4000);
      setToasts((list) => [...list, { id, type, message: toast.message }]);
      if (duration > 0) {
        timers.current.set(
          id,
          setTimeout(() => dismiss(id), duration)
        );
      }
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      push,
      dismiss,
      success: (message, options) => push({ type: 'success', message, ...options }),
      error: (message, options) => push({ type: 'error', message, ...options }),
      info: (message, options) => push({ type: 'info', message, ...options })
    }),
    [push, dismiss]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack" role="region" aria-live="polite">
        {toasts.map((toast) => {
          const Icon = ICONS[toast.type] || InfoIcon;
          return (
            <div key={toast.id} className={`toast toast-${toast.type}`} role="status">
              <span className="toast-icon">
                <Icon />
              </span>
              <span className="toast-message">{toast.message}</span>
              <button
                type="button"
                className="toast-close"
                onClick={() => dismiss(toast.id)}
                aria-label="Dismiss notification"
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}
