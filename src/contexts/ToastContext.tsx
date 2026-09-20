import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Info, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Spinner, SuccessCheck } from '../components/ui/feedback';

type ToastKind = 'success' | 'error' | 'info' | 'loading';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  dismissAfter: number;
}

interface ToastContextValue {
  toast: (kind: ToastKind, message: string, dismissAfter?: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const KIND_STYLES: Record<ToastKind, { icon: string; ring: string }> = {
  success: { icon: 'text-low-600 dark:text-low-500', ring: 'border-low-500/30' },
  error: { icon: 'text-destructive', ring: 'border-destructive/30' },
  info: { icon: 'text-primary', ring: 'border-primary/30' },
  loading: { icon: 'text-primary', ring: 'border-primary/30' },
};

function ToastIcon({ kind }: { kind: ToastKind }) {
  if (kind === 'success') {
    return <SuccessCheck className="size-5 text-low-600 dark:text-low-500" />;
  }
  if (kind === 'loading') {
    return <Spinner className="size-4 text-primary" />;
  }
  if (kind === 'error') {
    return <X className="size-4 text-destructive" aria-hidden="true" />;
  }
  return <Info className="size-4 text-primary" aria-hidden="true" />;
}

function ToastView({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: number) => void;
}) {
  const { icon, ring } = KIND_STYLES[item.kind];
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'animate-slide-down pointer-events-auto flex w-80 items-start gap-3 rounded-lg border bg-popover px-3.5 py-3 text-sm shadow-lg',
        ring,
      )}
    >
      <span className={cn('mt-0.5 flex size-6 shrink-0 items-center justify-center', icon)}>
        <ToastIcon kind={item.kind} />
      </span>
      <p className="min-w-0 flex-1 leading-snug text-popover-foreground">{item.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(item.id)}
        aria-label="Dismiss notification"
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden="true" />
      </button>
    </div>
  );
}

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const timersRef = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (kind: ToastKind, message: string, dismissAfter = 4200) => {
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        dismiss(id);
      }, dismissAfter);
      timersRef.current.set(id, timer);
      setItems((current) => [...current.slice(-3), { id, kind, message, dismissAfter }]);
    },
    [dismiss],
  );

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex flex-col gap-2">
        {items.map((item) => (
          <ToastView key={item.id} item={item} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
}