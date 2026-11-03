// Pulls your own Garmin data and merges it into the log. Runs on demand and nightly.
//
// The rule that matters: a value you typed is never overwritten by a blank, and a
// value Garmin supplies never overwrites one you typed. Garmin fills gaps; you stay
// in charge. Wellness rows land in hl2:sleep (same shape the sleep tab reads) and the
// extra fields — steps, stress, HRV — land in hl2:wellness, keyed by date.
import { admin, env, json, userFromRequest } from "./lib/shared.js";
import {
  garminReady, getToken, fetchKind,
  readSleep, readDaily, readHrv, readBodyBattery, readWeight, readFitnessAge,
} from "./lib/garmin.js";

const SLEEP = "hl2:sleep", WELL = "hl2:wellness", DAYS = "hl2:days", PATHS = "hl2:garminPaths", STATE = "hl2:garminState";

async function getKey(db, userId, key, fallback) {
  const { data } = await db.from("hl_store").select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  return data?.value ?? fallback;
}
async function setKey(db, userId, key, value) {
  await db.from("hl_store").upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
}

/* fill blanks only */
const fill = (have, incoming) => {
  const out = { ...have };
  for (const [k, v] of Object.entries(incoming)) if (v != null && (out[k] == null || out[k] === "")) out[k] = v;
  return out;
};

export async function syncOne(db, userId, { days = 14, dry = false } = {}) {
  const token = await getToken();
  const to = new Date(), from = new Date(Date.now() - days * 864e5);
  const remembered = await getKey(db, userId, PATHS, {});
  const found = {}, report = {};

  for (const kind of ["sleeps", "dailies", "hrv", "bodyBattery", "weight", "fitnessAge"]) {
    const r = await fetchKind(token, kind, from, to, remembered[kind]);
    report[kind] = { rows: r.rows.length, path: r.path, via: r.params, attempts: r.tried.length };
    if (r.path) remembered[kind] = r.path;
    found[kind] = r.rows;
  }

  const sleep = await getKey(db, userId, SLEEP, []);
  const well = await getKey(db, userId, WELL, []);
  const sleepBy = new Map(sleep.map((s) => [s.date, s]));
  const wellBy = new Map(well.map((s) => [s.date, s]));
  let sleepAdded = 0, wellAdded = 0;

  for (const r of found.sleeps) {
    const x = readSleep(r); if (!x.date) continue;
    const cur = sleepBy.get(x.date) || { date: x.date };
    const merged = fill(cur, { score: x.score, asleepMin: x.asleepMin, restingHr: x.restingHr, bedtime: x.bedtime });
    if (JSON.stringify(merged) !== JSON.stringify(cur)) { sleepBy.set(x.date, merged); sleepAdded++; }
    // stages and vitals go to the wellness record
    const w = wellBy.get(x.date) || { date: x.date };
    wellBy.set(x.date, fill(w, { deepMin: x.deepMin, remMin: x.remMin, awakeMin: x.awakeMin, spo2: x.spo2, respiration: x.respiration }));
  }
  for (const r of found.dailies) {
    const x = readDaily(r); if (!x.date) continue;
    const w = wellBy.get(x.date) || { date: x.date };
    const merged = fill(w, { steps: x.steps, stressAvg: x.stressAvg, stressMax: x.stressMax, intensityMin: x.intensityMin,
      floors: x.floors, calories: x.calories, bodyBatteryHigh: x.bodyBatteryHigh, bodyBatteryLow: x.bodyBatteryLow });
    wellBy.set(x.date, merged); wellAdded++;
    const cur = sleepBy.get(x.date) || { date: x.date };
    sleepBy.set(x.date, fill(cur, { restingHr: x.restingHr, bodyBattery: x.bodyBatteryWake }));
  }
  for (const r of found.hrv) {
    const x = readHrv(r); if (!x.date || x.hrv == null) continue;
    const w = wellBy.get(x.date) || { date: x.date };
    wellBy.set(x.date, fill(w, { hrv: x.hrv, hrvStatus: x.hrvStatus }));
  }
  for (const r of found.bodyBattery) {
    const x = readBodyBattery(r); if (!x.date) continue;
    const cur = sleepBy.get(x.date) || { date: x.date };
    sleepBy.set(x.date, fill(cur, { bodyBattery: x.bodyBatteryWake }));
    const w = wellBy.get(x.date) || { date: x.date };
    wellBy.set(x.date, fill(w, { bodyBatteryHigh: x.bodyBatteryHigh, bodyBatteryLow: x.bodyBatteryLow }));
  }
  for (const r of found.weight) {
    const x = readWeight(r); if (!x.date || x.weightKg == null) continue;
    const w = wellBy.get(x.date) || { date: x.date };
    wellBy.set(x.date, fill(w, { weightKg: x.weightKg }));
  }
  for (const r of found.fitnessAge) {
    const x = readFitnessAge(r); if (!x.date) continue;
    const cur = sleepBy.get(x.date) || { date: x.date };
    sleepBy.set(x.date, fill(cur, { fitnessAge: x.fitnessAge, vo2: x.vo2 }));
  }

  // steps also fill the day record the Day panel reads, so the existing field lights up
  const days_ = await getKey(db, userId, DAYS, []);
  const dayBy = new Map(days_.map((d) => [d.date, d]));
  for (const [date, w] of wellBy) {
    if (w.steps != null) dayBy.set(date, fill(dayBy.get(date) || { date }, { steps: w.steps }));
  }

  if (!dry) {
    await setKey(db, userId, SLEEP, [...sleepBy.values()].sort((a, b) => (a.date < b.date ? -1 : 1)));
    await setKey(db, userId, WELL, [...wellBy.values()].sort((a, b) => (a.date < b.date ? -1 : 1)));
    await setKey(db, userId, DAYS, [...dayBy.values()].sort((a, b) => (a.date < b.date ? -1 : 1)));
    await setKey(db, userId, PATHS, remembered);
    await setKey(db, userId, STATE, { at: new Date().toISOString(), report });
  }
  return { sleepRows: found.sleeps.length, dailyRows: found.dailies.length, sleepFilled: sleepAdded, report };
}

export async function handler(event) {
  try {
    const q = event?.queryStringParameters || {};
    const db = admin();

    // scheduled invocations carry no user; do everyone who has connected
    if (!event?.headers?.authorization && !event?.headers?.Authorization) {
      if (!garminReady()) return json(200, { skipped: "GARMIN_PERSONAL_API_KEY not set" });
      const { data: users } = await db.auth.admin.listUsers();
      const out = [];
      for (const u of users?.users || []) {
        try { out.push({ user: u.email, ...(await syncOne(db, u.id, { days: 7 })) }); }
        catch (e) { console.error("garmin-sync", u.email, e?.message); out.push({ user: u.email, error: String(e.message) }); }
      }
      console.log("garmin-sync: done", JSON.stringify(out));
      return json(200, { results: out });
    }

    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!garminReady()) return json(503, { error: "Garmin is not connected: add GARMIN_PERSONAL_API_KEY in Netlify." });
    const days = Math.min(3650, Number(q.days) || 14);
    const res = await syncOne(db, user.id, { days, dry: q.dry === "1" });
    return json(200, res);
  } catch (e) {
    console.error("garmin-sync:", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}
