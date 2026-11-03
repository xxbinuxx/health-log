/* A long Garmin pull, done politely and resumably.

   Garmin publishes no rate limit and sends no Retry-After. Other developers find that bursts
   draw a 429 and requests a couple of seconds apart do not, and that failed requests count
   against the limit too. So this walks a list of single requests one at a time with a gap
   between them, stops the instant it is told to wait, and remembers exactly where it was.

   It is a plain module with its clock and its requests passed in, so the stop, resume and
   cooldown behaviour can be tested without a browser or a network. */

/* How long to wait after a 429. Garmin does not say, so this escalates: first a quarter
   of an hour, then half, then an hour. A success after a wait resets it. */
export const COOLDOWNS_MIN = [15, 30, 60];
export const cooldownFor = (strikes) => COOLDOWNS_MIN[Math.min(Math.max(0, strikes), COOLDOWNS_MIN.length - 1)];

export const DEFAULT_GAP_MS = 2500;

/* What a pull will cost, shown before it starts. */
export function estimate(requests, gapMs = DEFAULT_GAP_MS) {
  const seconds = Math.round((requests * gapMs) / 1000);
  return { requests, seconds, label: seconds < 90 ? `about ${Math.max(10, seconds)} seconds` : `about ${Math.round(seconds / 60)} minutes` };
}

/**
 * @param steps       [{kind, from, to}] — one request each, newest first
 * @param start       where to begin (a saved cursor)
 * @param call        async (step) => {rows} | {rateLimited:true} | {failed:true, error}
 * @param sleep       async (ms) — injected, so tests do not wait
 * @param shouldStop  () => boolean, checked between requests
 * @param onStep      ({i, total, step, rows}) progress callback
 * @returns {status: "done"|"rate_limited"|"failed"|"stopped", next, rows, error?}
 */
export async function runBackfill({ steps, start = 0, call, sleep, gapMs = DEFAULT_GAP_MS, shouldStop = () => false,
  onStep = () => {}, retries = 2, retryGapMs = 5000 }) {
  let rows = 0;
  for (let i = Math.max(0, start); i < steps.length; i++) {
    if (shouldStop()) return { status: "stopped", next: i, rows };
    onStep({ i, total: steps.length, step: steps[i], rows });

    let result = null, lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        result = await call(steps[i]);
      } catch (e) {                                   // the request itself did not complete
        lastError = String(e?.message || e);
        result = null;
      }
      if (result?.rateLimited) return { status: "rate_limited", next: i, rows };   // never retry into a limit
      if (result && !result.failed) break;
      if (result?.failed) lastError = result.error || "Garmin returned an error";
      if (attempt < retries) await sleep(retryGapMs);
      result = null;
    }
    // a window that would not load is never skipped quietly: that would leave a hole in the history
    if (!result) return { status: "failed", next: i, rows, error: lastError };

    rows += result.rows || 0;
    if (i < steps.length - 1) await sleep(gapMs);
  }
  return { status: "done", next: steps.length, rows };
}
