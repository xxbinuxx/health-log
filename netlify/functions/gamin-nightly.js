// The scheduled Garmin pull. This is the ONLY Garmin function with a schedule.
//
// Netlify will not let you call a scheduled function from a browser, so the buttons on the
// Wellness tab talk to garmin-sync, which has no schedule, and this one runs on the clock.
//
// WHEN IT RUNS. Your sleep is over by about 11am New York time, so that is when the day's
// pull happens. But the watch only reaches Garmin Connect when it syncs to your phone, which
// can be later on a day you slept in. So after the 11:00 pull it keeps checking each hour
// until today's sleep has actually appeared, then stops. A normal day is one pull; a late
// day is a few. Nothing is pulled before 11:00 or after the early evening.
//
// Cron cannot express "11am in New York", because the clock changes twice a year. So the
// schedule fires at every UTC hour that could be 11:00 to 17:00 there, and this function
// reads the New York clock itself and decides whether to act. Most invocations stop at once.
import { admin, env } from "./lib/shared.js";
import { garminReady } from "./lib/garmin.js";
import { syncOne, getKey, setKey } from "./garmin-sync.js";

const SLEEP = "hl2:sleep", STATE = "hl2:garminState";
const COOLDOWN_MIN = 90;        // after a 429: Garmin does not say how long, so be generous

const tzOf = () => env("BRIEF_TZ") || "America/New_York";
const syncHour = () => { const n = Number(env("GARMIN_SYNC_HOUR")); return Number.isFinite(n) && env("GARMIN_SYNC_HOUR") !== "" ? n : 11; };
const CATCH_UP_UNTIL = 18;      // last catch-up attempt is the 17:00 hour

export const hourIn = (now, tz) => Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
export const dateIn = (now, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/* Pure, so it can be tested across daylight-saving changes without waiting for them. */
export function decide({ now, tz = "America/New_York", at = 11, until = CATCH_UP_UNTIL, haveSleepToday = false, cooldownUntil = 0 }) {
  const hour = hourIn(now, tz);
  if (cooldownUntil && cooldownUntil > now.getTime()) return { run: false, hour, why: "cooling down after Garmin rate-limited the key" };
  if (hour === at) return { run: true, hour, why: "the daily pull" };
  if (hour > at && hour < until) {
    return haveSleepToday ? { run: false, hour, why: "today's sleep is already in" }
      : { run: true, hour, why: "catching up: today's sleep has not appeared yet" };
  }
  return { run: false, hour, why: hour < at ? "too early; waiting for 11" : "past the catch-up window" };
}

export async function runNightly(db, { now = new Date() } = {}) {
  if (!garminReady()) { console.log("garmin-nightly: GARMIN_PERSONAL_API_KEY not set, skipping"); return []; }
  const tz = tzOf(), at = syncHour(), today = dateIn(now, tz);
  const { data: users } = await db.auth.admin.listUsers();
  const out = [];
  for (const u of users?.users || []) {
    try {
      const [sleep, state] = await Promise.all([getKey(db, u.id, SLEEP, []), getKey(db, u.id, STATE, null)]);
      const rec = sleep.find((s) => s.date === today);
      const haveSleepToday = !!rec && (rec.asleepMin != null || rec.score != null);
      const d = decide({ now, tz, at, haveSleepToday, cooldownUntil: state?.cooldownUntil || 0 });
      if (!d.run) { console.log(`garmin-nightly: ${u.email} skipped at ${d.hour}:00 — ${d.why}`); out.push({ user: u.email, skipped: d.why }); continue; }

      console.log(`garmin-nightly: ${u.email} running at ${d.hour}:00 — ${d.why}`);
      // nobody is waiting on this one, so space requests out generously and allow most of the 30 seconds
      const r = await syncOne(db, u.id, { days: 7, gapMs: 1800, deadlineMs: 26000 });
      if (r.rateLimited) {
        await setKey(db, u.id, STATE, { ...(state || {}), rateLimitedAt: now.toISOString(), cooldownUntil: now.getTime() + COOLDOWN_MIN * 60000 });
        console.log(`garmin-nightly: rate limited, pausing for ${COOLDOWN_MIN} minutes`);
        out.push({ user: u.email, rateLimited: true });
        continue;
      }
      out.push({ user: u.email, ran: d.why, ms: r.ms, rows: Object.values(r.report).reduce((a, v) => a + (v.rows || 0), 0), partial: r.partial });
    } catch (e) {
      console.error("garmin-nightly:", u.email, e?.message || e);
      out.push({ user: u.email, error: String(e.message || e) });
    }
  }
  console.log("garmin-nightly: done", JSON.stringify(out));
  return out;
}

// scheduled functions return no body, so there is nothing to build for the response
export async function handler() {
  await runNightly(admin());
  return { statusCode: 200 };
}
