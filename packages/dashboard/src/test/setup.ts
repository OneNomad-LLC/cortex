import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

/**
 * Vitest setup file — runs once per test file before the tests do.
 * React 19 doesn't auto-unmount between tests, so any rendered tree
 * sticks around in the happy-dom JSDOM-like environment until we
 * call `cleanup()`. Doing it in an `afterEach` here keeps test files
 * focused on assertions without each one having to remember.
 */
afterEach(() => {
  cleanup();
});

/**
 * Radix UI primitives (Select, DropdownMenu, etc.) call pointer-capture
 * APIs that happy-dom / jsdom don't yet implement. Polyfill the trio
 * with no-ops so the components don't throw on interaction tests.
 *
 * `scrollIntoView` is also stubbed for the same reason — Radix uses it
 * to keep the active list item visible.
 */
if (typeof Element !== "undefined") {
  type ElementWithPointer = Element & {
    hasPointerCapture?: (id: number) => boolean;
    releasePointerCapture?: (id: number) => void;
    setPointerCapture?: (id: number) => void;
    scrollIntoView?: (arg?: ScrollIntoViewOptions | boolean) => void;
  };
  const proto = Element.prototype as ElementWithPointer;
  if (typeof proto.hasPointerCapture !== "function") {
    proto.hasPointerCapture = () => false;
  }
  if (typeof proto.releasePointerCapture !== "function") {
    proto.releasePointerCapture = () => undefined;
  }
  if (typeof proto.setPointerCapture !== "function") {
    proto.setPointerCapture = () => undefined;
  }
  if (typeof proto.scrollIntoView !== "function") {
    proto.scrollIntoView = () => undefined;
  }
}
