import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combine class names with Tailwind-aware conflict resolution. Pairs
 * `clsx` (conditional logic, falsy filtering) with `tailwind-merge`
 * (later utility wins on the same property). Lifted verbatim from
 * shadcn/ui's recommended helper — kept in `lib/utils` so component
 * imports match the upstream snippet conventions.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
