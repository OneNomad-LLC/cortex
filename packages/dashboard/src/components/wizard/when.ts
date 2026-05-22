/**
 * Tiny hand-rolled predicate evaluator for wizard `when` clauses.
 *
 * Why not jsep / sandboxed eval / json-logic? The wizard spec lives in
 * @onenomad/przm-cortex-core and ships to the browser. Pulling a
 * generic expression library would (a) add hundreds of KB of JS for a
 * surface that only needs six operators, and (b) widen the attack
 * surface — `eval`-style libraries occasionally regress. A closed
 * verb list with explicit recursion keeps everything auditable.
 *
 * Closed verb list:
 *   { eq:  [key, value] }        — answers[key] === value
 *   { neq: [key, value] }        — answers[key] !== value
 *   { in:  [key, [v1, v2, ...]]} — answers[key] is one of the listed values
 *   { "not-empty": key }         — answers[key] is truthy + non-empty (incl. arrays)
 *   { and: [pred, pred, ...] }   — every predicate true
 *   { or:  [pred, pred, ...] }   — any predicate true
 *   { not: pred }                — negation
 *
 * A predicate is also accepted as the literal boolean `true` (always show)
 * or `false` (never show). Unknown shapes default to `true` so that a
 * step authored against a future renderer version stays visible.
 */

export type WhenPredicate =
  | boolean
  | { eq: [string, unknown] }
  | { neq: [string, unknown] }
  | { in: [string, unknown[]] }
  | { "not-empty": string }
  | { and: WhenPredicate[] }
  | { or: WhenPredicate[] }
  | { not: WhenPredicate };

export function evaluateWhen(
  pred: WhenPredicate | undefined,
  answers: Record<string, unknown>,
): boolean {
  if (pred === undefined) return true;
  if (typeof pred === "boolean") return pred;
  if (typeof pred !== "object" || pred === null) return true;

  if ("eq" in pred) {
    const [k, v] = pred.eq;
    return answers[k] === v;
  }
  if ("neq" in pred) {
    const [k, v] = pred.neq;
    return answers[k] !== v;
  }
  if ("in" in pred) {
    const [k, list] = pred.in;
    return Array.isArray(list) && list.includes(answers[k]);
  }
  if ("not-empty" in pred) {
    const v = answers[pred["not-empty"]];
    if (v == null) return false;
    if (typeof v === "string") return v.trim().length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v as object).length > 0;
    return Boolean(v);
  }
  if ("and" in pred) {
    return pred.and.every((p) => evaluateWhen(p, answers));
  }
  if ("or" in pred) {
    return pred.or.some((p) => evaluateWhen(p, answers));
  }
  if ("not" in pred) {
    return !evaluateWhen(pred.not, answers);
  }
  // Unknown shape — default visible. New verbs added to the contract
  // shouldn't break older renderers; they just see the step.
  return true;
}
