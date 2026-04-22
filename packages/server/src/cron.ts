/**
 * Minimal cron parser / evaluator. Supports the subset used in
 * config/cortex.yaml adapter schedules:
 *
 *   *            any
 *   N            exact value
 *   N,M,O        list
 *   A-B          range (inclusive)
 *   *\/N          step (every N)
 *
 * Fields: minute hour dayOfMonth month dayOfWeek
 *   minute      0-59
 *   hour        0-23
 *   dayOfMonth  1-31
 *   month       1-12
 *   dayOfWeek   0-6  (0 = Sunday)
 *
 * Month and day-of-week as names aren't supported; they're never used
 * in adapter schedules so no point.
 */

export interface CronSchedule {
  minute: (n: number) => boolean;
  hour: (n: number) => boolean;
  dayOfMonth: (n: number) => boolean;
  month: (n: number) => boolean;
  dayOfWeek: (n: number) => boolean;
  source: string;
}

const RANGES: Record<keyof Omit<CronSchedule, "source">, [number, number]> = {
  minute: [0, 59],
  hour: [0, 23],
  dayOfMonth: [1, 31],
  month: [1, 12],
  dayOfWeek: [0, 6],
};

export function parseCron(expr: string): CronSchedule {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `cron: expected 5 fields, got ${fields.length} ('${expr}')`,
    );
  }
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    source: expr,
    minute: compileField("minute", m),
    hour: compileField("hour", h),
    dayOfMonth: compileField("dayOfMonth", dom),
    month: compileField("month", mon),
    dayOfWeek: compileField("dayOfWeek", dow),
  };
}

function compileField(
  name: keyof typeof RANGES,
  raw: string,
): (n: number) => boolean {
  const [min, max] = RANGES[name];
  const allowed = new Set<number>();

  for (const part of raw.split(",")) {
    const step = part.includes("/") ? Number.parseInt(part.split("/")[1] ?? "1", 10) : 1;
    const rangeExpr = part.split("/")[0] ?? "*";

    let from: number;
    let to: number;
    if (rangeExpr === "*") {
      from = min;
      to = max;
    } else if (rangeExpr.includes("-")) {
      const [a, b] = rangeExpr.split("-");
      from = Number.parseInt(a ?? "", 10);
      to = Number.parseInt(b ?? "", 10);
    } else {
      const n = Number.parseInt(rangeExpr, 10);
      from = n;
      to = n;
    }

    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      !Number.isFinite(step) ||
      step <= 0 ||
      from < min ||
      to > max
    ) {
      throw new Error(`cron: invalid field '${raw}' for ${name}`);
    }

    for (let i = from; i <= to; i += step) {
      allowed.add(i);
    }
  }

  return (n) => allowed.has(n);
}

/**
 * Return the next time-of-next-firing strictly after `from`. Walks
 * minute-by-minute; every adapter runs once per match.
 *
 * Upper bound of 366 * 24 * 60 iterations before we bail — catches
 * truly unmatchable schedules (e.g. dayOfMonth=31 month=2).
 */
export function nextFireAfter(schedule: CronSchedule, from: Date): Date {
  const next = new Date(from.getTime());
  // Advance to the next whole minute.
  next.setSeconds(0, 0);
  next.setMinutes(next.getMinutes() + 1);

  const maxIter = 366 * 24 * 60;
  for (let i = 0; i < maxIter; i++) {
    if (
      schedule.minute(next.getMinutes()) &&
      schedule.hour(next.getHours()) &&
      schedule.dayOfMonth(next.getDate()) &&
      schedule.month(next.getMonth() + 1) &&
      schedule.dayOfWeek(next.getDay())
    ) {
      return new Date(next.getTime());
    }
    next.setMinutes(next.getMinutes() + 1);
  }
  throw new Error(`cron: no firing time within a year for '${schedule.source}'`);
}
