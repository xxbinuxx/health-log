// Pulls your own Garmin data and merges it into the log.
//
// Three ways in, all through this one function (it carries no schedule, because Netlify
// cannot invoke a scheduled function by URL; the overnight run is garmin-nightly.js):
//   ?days=14               a short sync of recent days, requests spaced a little apart
//   ?plan=1&days=365       the list of single requests a backfill needs, newest first
//   ?kind=hrv&from=&to=    exactly one request, so the browser can pace a long backfill
//
// Garmin publishes no rate limit and sends no Retry-After. Other developers find that a
// burst gets a 429 and requests a couple of seconds apart do not. So requests are paced,
// a 429 stops everything rather than being retried, and it is reported as an answer
// ("rateLimited": true), not an error, so the caller can wait and resume.
import { admin, json, userFromRequest } from "./lib/shared.js";
import {
  garminReady, getToken, pullKind, pullFitnessAge, planWindows, makeGate, ENDPOINTS, RateLimited,
  readSleep, readDaily, readSteps, readStress, readHrv, readBodyBattery, readWeight, readFitnessAge,
} from "./lib/garmin.js";

const SLEEP = "hl2:sleep", WELL = "hl2:wellness", DAYS = "hl2:days", STATE = "hl2:garminState";
const ALL_KINDS = Object.keys(ENDPOINTS);

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

async function loadMaps(db, userId) {
  const [sleep, well, days] = await Promise.all([getKey(db, userId, SLEEP, []), getKey(db, userId, WELL, []), getKey(db, userId, DAYS, [])]);
  const m = { sleepBy: new Map(sleep.map((s) => [s.date, s])), wellBy: new Map(well.map((s) => [s.date, s])), dayBy: new Map(days.map((s) => [s.date, s])) };
  m.touchW = (date, patch) => m.wellBy.set(date, merge(m.wellBy.get(date) || { date }, patch));
  m.touchS = (date, patch) => m.sleepBy.set(date, merge(m.sleepBy.get(date) || { date }, patch));
  return m;
}
async function saveMaps(db, userId, m) {
  // steps also fill the field the Day panel already reads
  for (const [date, w] of m.wellBy) if (w.steps != null) m.dayBy.set(date, merge(m.dayBy.get(date) || { date }, { steps: w.steps }));
  const sorted = (x) => [...x.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  await Promise.all([setKey(db, userId, SLEEP, sorted(m.sleepBy)), setKey(db, userId, WELL, sorted(m.wellBy)), setKey(db, userId, DAYS, sorted(m.dayBy))]);
}

/* One kind of row into the maps. */
function ingest(m, kind, rows) {
  for (const r of rows) {
    if (kind === "sleeps") {
      const x = readSleep(r); if (!x.date) continue;
      m.touchS(x.date, { score: x.score, asleepMin: x.asleepMin, restingHr: x.restingHr, bedtime: x.bedtime });
      m.touchW(x.date, { deepMin: x.deepMin, remMin: x.remMin, awakeMin: x.awakeMin, spo2: x.spo2, respiration: x.respiration });
    } else if (kind === "dailies") {
      const x = readDaily(r); if (!x.date) continue;
      m.touchW(x.date, { steps: x.steps, stressAvg: x.stressAvg, stressMax: x.stressMax, intensityMin: x.intensityMin,
        floors: x.floors, calories: x.calories, bodyBatteryHigh: x.bodyBatteryHigh, bodyBatteryLow: x.bodyBatteryLow });
      m.touchS(x.date, { restingHr: x.restingHr, bodyBattery: x.bodyBatteryWake });
    } else if (kind === "steps") { const x = readSteps(r); if (x.date) m.touchW(x.date, { steps: x.steps }); }
    else if (kind === "stress") { const x = readStress(r); if (x.date) m.touchW(x.date, { stressAvg: x.stressAvg, stressMax: x.stressMax }); }
    else if (kind === "hrv") { const x = readHrv(r); if (x.date && x.hrv != null) m.touchW(x.date, { hrv: x.hrv, hrvStatus: x.hrvStatus }); }
    else if (kind === "bodyBattery") {
      const x = readBodyBattery(r); if (!x.date) continue;
      m.touchS(x.date, { bodyBattery: x.bodyBatteryWake });
      m.touchW(x.date, { bodyBatteryHigh: x.bodyBatteryHigh, bodyBatteryLow: x.bodyBatteryLow });
    } else if (kind === "weight") { const x = readWeight(r); if (x.date && x.weightKg != null) m.touchW(x.date, { weightKg: x.weightKg }); }
  }
}

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const rateLimitedAnswer = (extra = {}) => ({ rateLimited: true, retryAfter: null, ...extra });

/* A short sync of recent days. Requests start 500 ms apart rather than all at once. */
export async function syncOne(db, userId, { days = 14, before = 0, dry = false, gapMs = 500, deadlineMs = 7000 } = {}) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  try {
    const token = await getToken(ctrl.signal);
    const to = iso(Date.now() - before * 864e5), from = iso(Date.now() - (before + days - 1) * 864e5);
    const gate = makeGate(gapMs);

    const [fitRes, ...results] = await Promise.all([
      before === 0 ? pullFitnessAge(token, to, ctrl.signal, gate) : Promise.resolve({ row: null, status: null }),
      ...ALL_KINDS.map((k) => pullKind(token, k, from, to, ctrl.signal, gate).then((r) => [k, r])),
    ]);
    const got = Object.fromEntries(results);
    const rateLimited = results.some(([, r]) => r.rateLimited) || fitRes.status === 429;

    const report = {};
    for (const k of ALL_KINDS) report[k] = { rows: got[k].rows.length, status: got[k].statuses.join(","), error: got[k].error, fields: got[k].sampleKeys };
    if (before === 0) report.fitnessAge = { rows: fitRes.row ? 1 : 0, status: String(fitRes.status ?? "") };

    const m = await loadMaps(db, userId);
    for (const k of ALL_KINDS) ingest(m, k, got[k].rows);
    if (fitRes.row) { const x = readFitnessAge(fitRes.row); m.touchS(to, { fitnessAge: x.fitnessAge, vo2: x.vo2 }); }

    if (!dry) {
      await saveMaps(db, userId, m);
      if (before === 0 && !rateLimited) await setKey(db, userId, STATE, { at: new Date().toISOString(), ok: true, authFailed: false, report });
    }
    return { from, to, ms: Date.now() - t0, partial: ctrl.signal.aborted, ...(rateLimited ? rateLimitedAnswer() : {}), report };
  } catch (e) {
    if (e instanceof RateLimited) return rateLimitedAnswer({ ms: Date.now() - t0, report: {} });
    if (e.authFailed && !dry) await setKey(db, userId, STATE, { at: new Date().toISOString(), ok: false, authFailed: true, error: String(e.message) });
    throw e;
  } finally { clearTimeout(timer); }
}

/* Exactly one request, for a backfill the browser paces itself. */
export async function syncWindow(db, userId, { kind, from, to }) {
  if (!ENDPOINTS[kind]) throw new Error(`unknown kind "${kind}"`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const token = await getToken(ctrl.signal);
    const r = await pullKind(token, kind, from, to, ctrl.signal);
    if (r.rateLimited) return rateLimitedAnswer({ kind, from, to, rows: 0 });
    // a window that failed for any other reason must not look like "no data"
    if (!r.rows.length && r.error && !/^(200|204)$/.test(r.statuses.join(","))) return { kind, from, to, rows: 0, failed: true, error: r.error, status: r.statuses.join(",") };
    const m = await loadMaps(db, userId);
    ingest(m, kind, r.rows);
    await saveMaps(db, userId, m);
    return { kind, from, to, rows: r.rows.length, status: r.statuses.join(",") };
  } catch (e) {
    if (e instanceof RateLimited) return rateLimitedAnswer({ kind, from, to, rows: 0 });
    throw e;
  } finally { clearTimeout(timer); }
}

export async function handler(event) {
  try {
    const q = event?.queryStringParameters || {};
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });

    // the plan needs no key and makes no request to Garmin
    if (q.plan === "1") {
      const n = Math.min(1100, Math.max(1, Number(q.days) || 365));
      const to = iso(Date.now()), from = iso(Date.now() - (n - 1) * 864e5);
      return json(200, { steps: planWindows(ALL_KINDS, from, to), from, to });
    }

    if (!garminReady()) return json(503, { error: "Garmin is not connected: add GARMIN_PERSONAL_API_KEY in Netlify, then deploy." });

    if (q.kind) {
      if (!/^\d{4}-\d\d-\d\d$/.test(q.from || "") || !/^\d{4}-\d\d-\d\d$/.test(q.to || "")) return json(400, { error: "from and to must be YYYY-MM-DD." });
      return json(200, await syncWindow(db, user.id, { kind: q.kind, from: q.from, to: q.to }));
    }
    return json(200, await syncOne(db, user.id, {
      days: Math.min(60, Math.max(1, Number(q.days) || 14)),
      before: Math.max(0, Number(q.before) || 0),
      dry: q.dry === "1",
    }));
  } catch (e) {
    console.error("garmin-sync:", e?.message || e);
    return json(e.authFailed ? 401 : 500, { error: String(e.message || e), authFailed: !!e.authFailed });
  }
}
