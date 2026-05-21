import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Minimal click-outside dropdown menu. Doesn't pull Radix in — the
 * dashboard's only current consumers are the workspace switcher and
 * the profile/logout menu, both of which need:
 *
 *   - a trigger button
 *   - a popover anchored under it
 *   - close on outside click / Escape
 *   - keyboard focus into the panel
 *
 * If we grow to typeahead-friendly menus, swap this for the upstream
 * `@radix-ui/react-dropdown-menu` shadcn primitive without changing
 * the public API below.
 */

interface DropdownContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
}

const DropdownContext = React.createContext<DropdownContextValue | null>(null);

function useDropdown(): DropdownContextValue {
  const ctx = React.useContext(DropdownContext);
  if (!ctx) throw new Error("DropdownMenu primitives must be nested inside <DropdownMenu>");
  return ctx;
}

interface DropdownMenuProps {
  children: React.ReactNode;
}

export function DropdownMenu({ children }: DropdownMenuProps): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const triggerRef = React.useRef<HTMLButtonElement | null>(null);
  const value = React.useMemo(() => ({ open, setOpen, triggerRef }), [open]);
  return (
    <DropdownContext.Provider value={value}>
      <div className="relative inline-block text-left">{children}</div>
    </DropdownContext.Provider>
  );
}

interface DropdownMenuTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

export const DropdownMenuTrigger = React.forwardRef<
  HTMLButtonElement,
  DropdownMenuTriggerProps
>(({ children, onClick, ...props }, _ref) => {
  const { open, setOpen, triggerRef } = useDropdown();
  return (
    <button
      ref={triggerRef}
      type="button"
      aria-expanded={open}
      aria-haspopup="menu"
      onClick={(e) => {
        setOpen(!open);
        onClick?.(e);
      }}
      {...props}
    >
      {children}
    </button>
  );
});
DropdownMenuTrigger.displayName = "DropdownMenuTrigger";

interface DropdownMenuContentProps extends React.HTMLAttributes<HTMLDivElement> {
  align?: "start" | "end";
  children: React.ReactNode;
}

export function DropdownMenuContent({
  className,
  align = "end",
  children,
  ...props
}: DropdownMenuContentProps): React.ReactElement | null {
  const { open, setOpen, triggerRef } = useDropdown();
  const panelRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelRef.current?.contains(t)) return;
      if (triggerRef.current?.contains(t)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open, setOpen, triggerRef]);

  if (!open) return null;
  return (
    <div
      ref={panelRef}
      role="menu"
      className={cn(
        "absolute z-50 mt-2 min-w-[12rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none",
        align === "end" ? "right-0" : "left-0",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

interface DropdownMenuItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  inset?: boolean;
}

export const DropdownMenuItem = React.forwardRef<
  HTMLButtonElement,
  DropdownMenuItemProps
>(({ className, inset, onClick, type, ...props }, ref) => {
  const { setOpen } = useDropdown();
  return (
    <button
      ref={ref}
      role="menuitem"
      type={type ?? "button"}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) setOpen(false);
      }}
      className={cn(
        "relative flex w-full cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50",
        inset && "pl-8",
        className,
      )}
      {...props}
    />
  );
});
DropdownMenuItem.displayName = "DropdownMenuItem";

export function DropdownMenuSeparator({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      role="separator"
      {...props}
    />
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn("px-2 py-1.5 text-sm font-semibold", className)}
      {...props}
    />
  );
}
