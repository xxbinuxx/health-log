// Pulls your own Garmin data and merges it into the log. Runs on demand and nightly.
//
// Two rules. Garmin fills gaps but never overwrites something you typed. And this function
// always answers in JSON, under a deadline, because Netlify kills a function at about ten
// seconds and what it sends when it does is plain text the browser cannot read.
import { admin, json, userFromRequest } from "./lib/shared.js";
import {
  garminReady, getToken, pullKind, pullFitnessAge,
  readSleep, readDaily, readSteps, readStress, readHrv, readBodyBattery, readWeight, readFitnessAge,
} from "./lib/garmin.js";

const SLEEP = "hl2:sleep", WELL = "hl2:wellness", DAYS = "hl2:days", STATE = "hl2:garminState";
const DEADLINE_MS = 7000;

async function getKey(db, userId, key, fallback) {
  const { data } = await db.from("hl_store").select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  return data?.value ?? fallback;
}
async function setKey(db, userId, key, value) {
  await db.from("hl_store").upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
}

/* Fill blanks. A field Garmin supplied earlier may be refreshed (a sleep score is revised
   after you wake); a field you typed is never touched. Provenance rides along in `_g`. */
function merge(have, incoming) {
  const out = { ...have };
  const g = new Set(have._g || []);
  for (const [k, v] of Object.entries(incoming)) {
    if (v == null) continue;
    if (out[k] == null || out[k] === "" || g.has(k)) { out[k] = v; g.add(k); }
  }
  if (g.size) out._g = [...g];
  return out;
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

export async function syncOne(db, userId, { days = 14, before = 0, dry = false } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEADLINE_MS);
  try {
    const token = await getToken(ctrl.signal);
    const to = iso(Date.now() - before * 864e5), from = iso(Date.now() - (before + days - 1) * 864e5);

    const kinds = ["sleeps", "dailies", "steps", "stress", "hrv", "bodyBattery", "weight"];
    // everything at once, including the single-date fitness age, so nothing waits behind the deadline
    const [fitRes, ...results] = await Promise.all([
      before === 0 ? pullFitnessAge(token, to, ctrl.signal) : Promise.resolve({ row: null, status: null }),
      ...kinds.map((k) => pullKind(token, k, from, to, ctrl.signal).then((r) => [k, r])),
    ]);
    const got = Object.fromEntries(results);
    const fit = fitRes;

    const report = {};
    for (const k of kinds) report[k] = { rows: got[k].rows.length, status: got[k].statuses.join(","), error: got[k].error, fields: got[k].sampleKeys };
    if (before === 0) report.fitnessAge = { rows: fit.row ? 1 : 0, status: String(fit.status ?? "") };

    const sleep = await getKey(db, userId, SLEEP, []);
    const well = await getKey(db, userId, WELL, []);
    const days_ = await getKey(db, userId, DAYS, []);
    const sleepBy = new Map(sleep.map((s) => [s.date, s]));
    const wellBy = new Map(well.map((s) => [s.date, s]));
    const dayBy = new Map(days_.map((s) => [s.date, s]));
    const touchW = (date, patch) => wellBy.set(date, merge(wellBy.get(date) || { date }, patch));
    const touchS = (date, patch) => sleepBy.set(date, merge(sleepBy.get(date) || { date }, patch));

    for (const r of got.sleeps.rows) {
      const x = readSleep(r); if (!x.date) continue;
      touchS(x.date, { score: x.score, asleepMin: x.asleepMin, restingHr: x.restingHr, bedtime: x.bedtime });
      touchW(x.date, { deepMin: x.deepMin, remMin: x.remMin, awakeMin: x.awakeMin, spo2: x.spo2, respiration: x.respiration });
    }
    for (const r of got.dailies.rows) {
      const x = readDaily(r); if (!x.date) continue;
      touchW(x.date, { steps: x.steps, stressAvg: x.stressAvg, stressMax: x.stressMax, intensityMin: x.intensityMin,
        floors: x.floors, calories: x.calories, bodyBatteryHigh: x.bodyBatteryHigh, bodyBatteryLow: x.bodyBatteryLow });
      touchS(x.date, { restingHr: x.restingHr, bodyBattery: x.bodyBatteryWake });
    }
    for (const r of got.steps.rows) { const x = readSteps(r); if (x.date) touchW(x.date, { steps: x.steps }); }
    for (const r of got.stress.rows) { const x = readStress(r); if (x.date) touchW(x.date, { stressAvg: x.stressAvg, stressMax: x.stressMax }); }
    for (const r of got.hrv.rows) { const x = readHrv(r); if (x.date && x.hrv != null) touchW(x.date, { hrv: x.hrv, hrvStatus: x.hrvStatus }); }
    for (const r of got.bodyBattery.rows) {
      const x = readBodyBattery(r); if (!x.date) continue;
      touchS(x.date, { bodyBattery: x.bodyBatteryWake });
      touchW(x.date, { bodyBatteryHigh: x.bodyBatteryHigh, bodyBatteryLow: x.bodyBatteryLow });
    }
    for (const r of got.weight.rows) { const x = readWeight(r); if (x.date && x.weightKg != null) touchW(x.date, { weightKg: x.weightKg }); }
    if (fit.row) { const x = readFitnessAge(fit.row); touchS(to, { fitnessAge: x.fitnessAge, vo2: x.vo2 }); }

    // steps also fill the field the Day panel already reads
    for (const [date, w] of wellBy) if (w.steps != null) dayBy.set(date, merge(dayBy.get(date) || { date }, { steps: w.steps }));

    if (!dry) {
      const sorted = (m) => [...m.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
      await setKey(db, userId, SLEEP, sorted(sleepBy));
      await setKey(db, userId, WELL, sorted(wellBy));
      await setKey(db, userId, DAYS, sorted(dayBy));
      if (before === 0) await setKey(db, userId, STATE, { at: new Date().toISOString(), ok: true, authFailed: false, report });
    }
    return { from, to, ms: Date.now() - t0, partial: ctrl.signal.aborted, report };
  } catch (e) {
    if (e.authFailed && !dry) await setKey(db, userId, STATE, { at: new Date().toISOString(), ok: false, authFailed: true, error: String(e.message) });
    throw e;
  } finally { clearTimeout(timer); }
}

// Called from the browser, so it must NOT carry a schedule: Netlify cannot invoke a
// scheduled function by URL. The overnight run lives in garmin-nightly.js.
export async function handler(event) {
  try {
    const q = event?.queryStringParameters || {};
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!garminReady()) return json(503, { error: "Garmin is not connected: add GARMIN_PERSONAL_API_KEY in Netlify, then deploy." });
    const res = await syncOne(db, user.id, {
      days: Math.min(60, Math.max(1, Number(q.days) || 14)),
      before: Math.max(0, Number(q.before) || 0),
      dry: q.dry === "1",
    });
    return json(200, res);
  } catch (e) {
    console.error("garmin-sync:", e?.message || e);
    return json(e.authFailed ? 401 : 500, { error: String(e.message || e), authFailed: !!e.authFailed });
  }
}
