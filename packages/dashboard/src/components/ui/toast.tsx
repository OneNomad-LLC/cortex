import * as React from "react";

/**
 * Tiny toast surface for the Ingest page's success/error blurbs. Lives
 * in /pages directly until the shell teammate lands a richer notifier
 * (likely radix-toast). Public API mirrors the eventual shape:
 *
 *   const { toast } = useToast();
 *   toast({ title: "Job queued", description: "..." });
 *
 * Wrap the SPA in <ToastProvider> at the root (App.tsx) once.
 */
interface Toast {
  id: number;
  title: string;
  description?: string;
  variant?: "default" | "destructive";
}

interface ToastContextValue {
  toast: (input: Omit<Toast, "id">) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    // Render-free fallback so a page that mounts before <ToastProvider>
    // wires up doesn't crash — toasts just no-op.
    return { toast: () => undefined };
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(1);
  const toast = React.useCallback((input: Omit<Toast, "id">) => {
    const id = nextId.current++;
    setToasts((prev) => [...prev, { id, ...input }]);
    // Auto-dismiss after 5s so the surface never lingers.
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);
  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto min-w-[280px] max-w-sm rounded-md border bg-background px-4 py-3 shadow-lg ${
              t.variant === "destructive" ? "border-destructive" : ""
            }`}
            role="status"
          >
            <div className="text-sm font-medium">{t.title}</div>
            {t.description && (
              <div className="mt-1 text-xs text-muted-foreground">
                {t.description}
              </div>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
