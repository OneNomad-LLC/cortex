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
