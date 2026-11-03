// The overnight run. This is the ONLY Garmin function with a schedule.
//
// Netlify will not let you call a scheduled function from a browser, so the button on the
// Wellness tab talks to garmin-sync, which has no schedule, and this one runs on the clock.
// Both use the same syncOne, so they behave the same.
import { admin } from "./lib/shared.js";
import { garminReady } from "./lib/garmin.js";
import { syncOne } from "./garmin-sync.js";

export async function runNightly(db) {
  if (!garminReady()) { console.log("garmin-nightly: GARMIN_PERSONAL_API_KEY not set, skipping"); return []; }
  const { data: users } = await db.auth.admin.listUsers();
  const out = [];
  for (const u of users?.users || []) {
    try {
      const r = await syncOne(db, u.id, { days: 7 });
      out.push({ user: u.email, ms: r.ms, rows: Object.values(r.report).reduce((a, v) => a + (v.rows || 0), 0), partial: r.partial });
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
