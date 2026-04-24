/**
 * Renders the "⊕ Cortex" action button + toast inside a shadow DOM
 * sibling of <body>. Shadow DOM means page stylesheets can't
 * accidentally paint over us and our styles can't leak into the page.
 *
 * Public API:
 *   - mountFloatingUi() → returns a controller. Call once per page.
 *   - controller.showButton(rect, onClick)
 *   - controller.hideButton()
 *   - controller.toast(message, kind)  // kind: "success" | "error" | "info"
 */

export interface FloatingController {
  showButton(rect: DOMRect, onClick: () => void): void;
  hideButton(): void;
  toast(message: string, kind?: "success" | "error" | "info"): void;
  destroy(): void;
}

const HOST_ID = "cortex-floating-host";

const CSS = `
:host { all: initial; }
.btn {
  position: fixed;
  z-index: 2147483647;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  padding: 6px 10px;
  border-radius: 999px;
  background: rgb(79, 70, 229);
  color: white;
  border: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  cursor: pointer;
  user-select: none;
  transition: transform 120ms ease, background 120ms ease;
}
.btn:hover { background: rgb(67, 56, 202); transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn.hidden { display: none; }

.toast-wrap {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.3;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgb(23, 23, 23);
  color: rgb(245, 245, 245);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
  max-width: 320px;
  opacity: 0;
  transform: translateY(8px);
  transition: opacity 160ms ease, transform 160ms ease;
}
.toast.in { opacity: 1; transform: translateY(0); }
.toast.success { background: rgb(22, 101, 52); }
.toast.error   { background: rgb(159, 18, 57); }
.toast.info    { background: rgb(30, 41, 59); }
`;

export function mountFloatingUi(): FloatingController {
  // If the content script reloads (Vite HMR during development) the
  // host may already exist — reuse it so we don't stack buttons.
  const existing = document.getElementById(HOST_ID);
  if (existing) existing.remove();

  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.all = "initial";
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn hidden";
  btn.textContent = "⊕ Cortex";
  shadow.appendChild(btn);

  const toastWrap = document.createElement("div");
  toastWrap.className = "toast-wrap";
  shadow.appendChild(toastWrap);

  document.documentElement.appendChild(host);

  let currentHandler: (() => void) | undefined;

  btn.addEventListener("mousedown", (e) => {
    // Prevent the click from stealing the user's text selection. A
    // plain click swallows the selection before our sendMessage runs.
    e.preventDefault();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    currentHandler?.();
  });

  return {
    showButton(rect, onClick) {
      currentHandler = onClick;
      const pad = 6;
      // Position just above-right of the selection; clamp to viewport.
      const x = Math.max(
        8,
        Math.min(window.innerWidth - 96, rect.right - 96),
      );
      const y = Math.max(8, rect.top - 28 - pad);
      btn.style.left = `${x}px`;
      btn.style.top = `${y}px`;
      btn.classList.remove("hidden");
    },
    hideButton() {
      btn.classList.add("hidden");
      currentHandler = undefined;
    },
    toast(message, kind = "info") {
      const el = document.createElement("div");
      el.className = `toast ${kind}`;
      el.textContent = message;
      toastWrap.appendChild(el);
      requestAnimationFrame(() => el.classList.add("in"));
      const ttl = kind === "error" ? 5000 : 2600;
      window.setTimeout(() => {
        el.classList.remove("in");
        window.setTimeout(() => el.remove(), 240);
      }, ttl);
    },
    destroy() {
      host.remove();
    },
  };
}
