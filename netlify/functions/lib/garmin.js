/* Garmin Connect Personal API, built against Garmin's own reference client
   (github.com/garmin/connect-personal-api-python), which lists every endpoint.

   Released 21 October 2026: free, read-only, pull-only, your own account only. You make a
   key in Garmin Connect, trade it for a 24-hour access token (no refresh tokens, so a new
   one each run), then call GET endpoints on personal.connectapi.garmin.com.

   Two things shape the code. First, Netlify kills a function at roughly ten seconds and
   what it returns then is plain text, not JSON, so everything here runs in parallel under
   a hard deadline and always hands back whatever arrived. Second, Garmin documents the
   data areas but not the field names inside them, so every reader tries several names and
   a missing field is a null, never an error and never a zero. */

import { env } from "./shared.js";

export const BASE = "https://personal.connectapi.garmin.com";
const TOKEN_URL = `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`;

export const garminReady = () => !!env("GARMIN_PERSONAL_API_KEY");

const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]+$/;

/* A token lasts 24 hours, so exchange once and reuse it while this instance stays warm.
   Every extra request counts toward Garmin's limit, and the exchange was being paid for
   on every call. Only the last few characters of the key are kept, to tell keys apart. */
const tokenCache = { token: null, exp: 0, tag: "" };
const jwtExp = (t) => { try { return JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString()).exp * 1000; } catch { return 0; } };

/* Garmin sends no Retry-After, so a rate limit is reported as "unknown wait". */
export class RateLimited extends Error {
  constructor(retryAfter) { super("Garmin is rate-limiting this key."); this.rateLimited = true; this.retryAfter = retryAfter; }
}

/* Spaces out when each request STARTS, so a burst becomes a trickle. Requests may still
   overlap in flight; it is the rate they begin at that gets counted. */
export function makeGate(gapMs) {
  let next = 0;
  return (signal) => {
    const now = Date.now(), at = Math.max(now, next);
    next = at + gapMs;
    const wait = at - now;
    if (wait <= 0) return Promise.resolve();
    return new Promise((res, rej) => {
      const t = setTimeout(res, wait);
      signal?.addEventListener("abort", () => { clearTimeout(t); const e = new Error("aborted"); e.name = "AbortError"; rej(e); }, { once: true });
    });
  };
}

/* The exchange returns a JWT, but the field it travels in is not documented, so look for it. */
export async function getToken(signal) {
  if (!garminReady()) throw new Error("GARMIN_PERSONAL_API_KEY is not set in Netlify");
  const tag = env("GARMIN_PERSONAL_API_KEY").slice(-6);
  if (tokenCache.token && tokenCache.tag === tag && tokenCache.exp - Date.now() > 36e5) return tokenCache.token;
  let r, text;
  try {
    r = await fetch(TOKEN_URL, { method: "POST", headers: { Authorization: `ApiKey ${env("GARMIN_PERSONAL_API_KEY")}` }, signal });
    text = await r.text();
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Garmin did not answer within seven seconds. Try again in a minute." : `Could not reach Garmin: ${e.message}`);
  }
  if (r.status === 401 || r.status === 403) {
    const e = new Error("Garmin rejected the key. It has expired or been deleted — make a new one at connect.garmin.com/app/settings/personalApiToken");
    e.authFailed = true; throw e;
  }
  if (!r.ok) throw new Error(`Garmin's token service returned ${r.status}. Try again shortly.`);
  const remember = (t) => { tokenCache.token = t; tokenCache.exp = jwtExp(t); tokenCache.tag = tag; return t; };
  if (r.status === 429) throw new RateLimited(null);
  if (JWT.test(text.trim())) return remember(text.trim());
  let j = null;
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  const hit = (o, depth = 0) => {
    if (!o || depth > 2) return null;
    if (typeof o === "string" && JWT.test(o)) return o;
    if (typeof o === "object") for (const v of Object.values(o)) { const f = hit(v, depth + 1); if (f) return f; }
    return null;
  };
  const token = hit(j);
  if (!token) throw new Error(`Garmin answered but no token was in it (${text.slice(0, 80).replace(/\s+/g, " ")})`);
  return remember(token);
}

const d = (x) => x.toISOString().slice(0, 10);
const addD = (iso, n) => { const x = new Date(`${iso}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return d(x); };

/* The endpoints, exactly as Garmin's reference lists them. `window` is how many days one
   request covers; Garmin does not publish per-endpoint limits, so ranges are cut into
   windows and a 400 falls back to a smaller one. */
export const ENDPOINTS = {
  // limits below are what other developers report (steps and stress 28 days, sleep and body
  // battery 31, HRV 365). Using the widest allowed window means the fewest requests, and
  // every request counts against a limit Garmin does not publish.
  sleeps:      { url: (a, b) => `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${a}&endDate=${b}`, window: 31 },
  dailies:     { url: (a, b) => `/usersummary-service/v2/dailysummaries?startDate=${a}&endDate=${b}`, window: 28 },
  steps:       { url: (a, b) => `/usersummary-service/stats/steps/daily/${a}/${b}`, window: 28 },
  stress:      { url: (a, b) => `/usersummary-service/stats/stress/daily/${a}/${b}`, window: 28 },
  hrv:         { url: (a, b) => `/hrv-service/hrv/daily/${a}/${b}`, window: 365 },
  bodyBattery: { url: (a, b) => `/wellness-service/wellness/bodyBattery/reports/daily?startDate=${a}&endDate=${b}`, window: 31 },
  weight:      { url: (a, b) => `/weight-service/weight/range/${a}/${b}?includeAll=true`, window: 180 },
};

/* The requests needed to cover a range, newest first. The browser walks this list one
   request at a time, so the schedule has one author and cannot drift from the server. */
export function planWindows(kinds, from, to) {
  const out = [];
  for (const kind of kinds) {
    const w = ENDPOINTS[kind].window;
    for (let b = to; b >= from; ) {
      const a = addD(b, -(w - 1));
      out.push({ kind, from: a < from ? from : a, to: b });
      b = addD(a, -1);
    }
  }
  // interleave kinds so a stop part-way leaves recent data of every kind, not all of one
  return out.sort((x, y) => (x.to < y.to ? 1 : x.to > y.to ? -1 : 0));
}
// a single date, not a range — only the latest is useful
export const FITNESS_AGE = (date) => `/fitnessage-service/fitnessage/v2/${date}`;

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

/* Rows come back as a bare array or wrapped under a name nobody told us. Find them. */
export function rowsOf(data) {
  if (Array.isArray(data)) return data;
  if (!isObj(data)) return [];
  // Garmin's v2 daily summaries pivot metrics by name: {allMetrics:{metricsMap:{NAME:[{value,calendarDate}]}}}
  const map = data.allMetrics?.metricsMap;
  if (isObj(map)) {
    const byDate = new Map();
    for (const [name, list] of Object.entries(map)) {
      if (!Array.isArray(list)) continue;
      const key = /RESTING_HEART_RATE/i.test(name) ? "restingHeartRate"
        : /TOTAL_STEPS|^WELLNESS_STEPS/i.test(name) ? "totalSteps"
        : /AVERAGE.*STRESS|STRESS.*AVERAGE/i.test(name) ? "averageStressLevel"
        : /BODY_BATTERY.*HIGH/i.test(name) ? "bodyBatteryHighestValue"
        : /BODY_BATTERY.*LOW/i.test(name) ? "bodyBatteryLowestValue" : name;
      for (const p of list) {
        if (!p?.calendarDate) continue;
        const row = byDate.get(p.calendarDate) || { calendarDate: p.calendarDate };
        row[key] = p.value; byDate.set(p.calendarDate, row);
      }
    }
    return [...byDate.values()];
  }
  // otherwise the first property that is a list of objects
  for (const v of Object.values(data)) if (Array.isArray(v) && v.length && isObj(v[0])) return v;
  for (const v of Object.values(data)) if (isObj(v)) { const inner = rowsOf(v); if (inner.length) return inner; }
  return data.calendarDate || data.date ? [data] : [];
}

/* Pull one level of nested objects up, so {values:{overallStressLevel}} reads as a flat row. */
export function flat(r) {
  if (!isObj(r)) return {};
  const out = { ...r };
  for (const [k, v] of Object.entries(r)) {
    const inner = isObj(v) ? v : Array.isArray(v) && isObj(v[0]) ? v[0] : null;
    if (!inner) continue;
    for (const [ik, iv] of Object.entries(inner)) if (!(ik in out)) out[ik] = iv;
  }
  return out;
}

/* One kind of data over a date range, in parallel windows, under a shared abort signal. */
export async function pullKind(token, kind, from, to, signal, gate) {
  const ep = ENDPOINTS[kind];
  const windows = [];
  for (let a = from; a <= to; a = addD(a, ep.window)) windows.push([a, addD(a, ep.window - 1) > to ? to : addD(a, ep.window - 1)]);

  const statuses = new Set();
  let firstError = null, rateLimited = false, retryAfter = null;
  const call = async (a, b) => {
    if (rateLimited) return [];                      // once limited, every further request only extends the wait
    try {
      await gate?.(signal);
      if (rateLimited) return [];
      const r = await fetch(`${BASE}${ep.url(a, b)}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal });
      statuses.add(r.status);
      if (r.status === 429) { rateLimited = true; retryAfter = Number(r.headers?.get?.("retry-after")) || null; return []; }
      if (r.status === 401 || r.status === 403) { const e = new Error(`${r.status}`); e.authFailed = true; throw e; }
      if (r.status === 400 && b > a) {                    // window too wide: halve it
        const mid = addD(a, Math.floor((Date.parse(b) - Date.parse(a)) / 864e5 / 2));
        const [x, y] = await Promise.all([call(a, mid), call(addD(mid, 1), b)]);
        return [...x, ...y];
      }
      if (!r.ok) { firstError ||= `${r.status}`; return []; }
      const text = await r.text();
      if (!text) return [];
      return rowsOf(JSON.parse(text));
    } catch (e) {
      if (e.authFailed) throw e;
      firstError ||= e.name === "AbortError" ? "timed out" : String(e.message || e);
      return [];
    }
  };
  const chunks = await Promise.all(windows.map(([a, b]) => call(a, b)));
  const rows = chunks.flat();
  return { rows, statuses: [...statuses], error: rows.length ? null : firstError, rateLimited, retryAfter,
    sampleKeys: rows[0] ? Object.keys(flat(rows[0])).slice(0, 40) : [] };
}

export async function pullFitnessAge(token, date, signal, gate) {
  if (signal?.aborted) return { row: null, status: 0 };
  try {
    await gate?.(signal);
    const r = await fetch(`${BASE}${FITNESS_AGE(date)}`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, signal });
    if (!r.ok) return { row: null, status: r.status };
    const t = await r.text();
    return { row: t ? JSON.parse(t) : null, status: r.status };
  } catch { return { row: null, status: 0 }; }
}

/* ---- tolerant readers ---- */

/* Number(null) is 0 and Number("") is 0, which would turn every missing field into a
   real-looking zero. Only a genuine number counts; {value: 81} is unwrapped because Garmin
   nests several scores that way. */
const num = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return num(v.value ?? v.score ?? v.overall ?? null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pick = (o, names) => { for (const n of names) if (o && o[n] != null && o[n] !== "") return o[n]; return null; };
const mins = (v) => { const n = num(v); return n == null ? null : Math.round(n / 60); };

const dateOf = (r) => {
  const x = pick(r, ["calendarDate", "calendar_date", "summaryDate", "date", "sleepDate", "startDate"]);
  if (x) return String(x).slice(0, 10);
  const t = pick(r, ["startTimeInSeconds", "startTimeGMT", "startTimeLocal", "sleepStartTimestampLocal", "startTimestampLocal"]);
  if (t == null) return null;
  const ms = typeof t === "number" ? (t > 1e12 ? t : t * 1000) : Date.parse(String(t).replace(" ", "T"));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

export function readSleep(raw) {
  const r = flat(raw);
  const direct = num(pick(r, ["sleepTimeSeconds", "durationInSeconds", "totalSleepSeconds", "sleepDurationInSeconds"]));
  const staged = ["deepSleepDurationInSeconds", "lightSleepDurationInSeconds", "remSleepInSeconds",
    "deepSleepSeconds", "lightSleepSeconds", "remSleepSeconds"].reduce((a, k) => a + (num(r[k]) || 0), 0);
  const secs = direct ?? (staged > 0 ? staged : null);
  const sc = r.sleepScores || {};
  const score = num(pick(r, ["overallSleepScore", "sleepScore", "overallScore"])) ?? num(sc.overall) ?? num(sc.overallScore) ?? num(r.overall);

  let bedtime = null;
  const startRaw = pick(r, ["sleepStartTimestampLocal", "startTimeLocal", "sleepStartLocal"]);
  if (startRaw) { const m = String(startRaw).match(/[T ](\d{2}):(\d{2})/); if (m) bedtime = `${m[1]}:${m[2]}`; }
  else if (num(r.startTimeInSeconds) != null) {
    const dt = new Date((num(r.startTimeInSeconds) + (num(r.startTimeOffsetInSeconds) ?? 0)) * 1000);
    bedtime = `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`;
  } else if (num(r.sleepStartTimestampGMT) != null) {
    // epoch milliseconds, GMT, with the local offset alongside
    const off = num(r.sleepStartTimestampLocal) != null ? num(r.sleepStartTimestampLocal) - num(r.sleepStartTimestampGMT) : 0;
    const dt = new Date(num(r.sleepStartTimestampGMT) + off);
    bedtime = `${String(dt.getUTCHours()).padStart(2, "0")}:${String(dt.getUTCMinutes()).padStart(2, "0")}`;
  }
  return {
    date: dateOf(r), score, asleepMin: secs ? Math.round(secs / 60) : null,
    restingHr: num(pick(r, ["restingHeartRate", "restingHeartRateInBeatsPerMinute", "restingHR"])),
    bedtime,
    deepMin: mins(pick(r, ["deepSleepDurationInSeconds", "deepSleepSeconds"])),
    remMin: mins(pick(r, ["remSleepInSeconds", "remSleepSeconds"])),
    awakeMin: mins(pick(r, ["awakeDurationInSeconds", "awakeSleepSeconds"])),
    spo2: num(pick(r, ["averageSpO2Value", "avgSpo2", "averageSpO2", "averageSpO2HRSleep"])),
    respiration: num(pick(r, ["averageRespirationValue", "avgRespiration", "averageRespiration"])),
  };
}

export function readDaily(raw) {
  const r = flat(raw);
  const mod = num(pick(r, ["moderateIntensityDurationInSeconds", "moderateIntensityMinutes"]));
  const vig = num(pick(r, ["vigorousIntensityDurationInSeconds", "vigorousIntensityMinutes"]));
  const asMin = (v, k) => (v == null ? null : r[k] != null && /Minutes/.test(k) ? v : v / 60);
  return {
    date: dateOf(r),
    steps: num(pick(r, ["totalSteps", "steps"])),
    restingHr: num(pick(r, ["restingHeartRate", "restingHeartRateInBeatsPerMinute", "restingHR"])),
    stressAvg: num(pick(r, ["averageStressLevel", "avgStressLevel", "overallStressLevel"])),
    stressMax: num(pick(r, ["maxStressLevel", "stressMax"])),
    bodyBatteryHigh: num(pick(r, ["bodyBatteryHighestValue", "bodyBatteryChargedValue"])),
    bodyBatteryLow: num(pick(r, ["bodyBatteryLowestValue"])),
    bodyBatteryWake: num(pick(r, ["bodyBatteryAtWakeTime", "bodyBatteryMostRecentValue"])),
    intensityMin: mod == null && vig == null ? null : Math.round((asMin(mod, "moderateIntensityDurationInSeconds") || 0) + 2 * (asMin(vig, "vigorousIntensityDurationInSeconds") || 0)),
    floors: num(pick(r, ["floorsAscended", "floorsClimbed", "floors"])),
    calories: num(pick(r, ["activeKilocalories", "caloriesBurned"])),
  };
}

export const readSteps = (raw) => { const r = flat(raw); return { date: dateOf(r), steps: num(pick(r, ["totalSteps", "steps"])) }; };
export const readStress = (raw) => { const r = flat(raw); return { date: dateOf(r), stressAvg: num(pick(r, ["overallStressLevel", "averageStressLevel", "avgStressLevel"])), stressMax: num(pick(r, ["maxStressLevel"])) }; };

export function readHrv(raw) {
  const r = flat(raw);
  return { date: dateOf(r), hrv: num(pick(r, ["lastNightAvg", "avgOvernightHrv", "hrvValue", "weeklyAvg"])), hrvStatus: pick(r, ["status", "hrvStatus"]) };
}

/* Body Battery arrives as a day of [timestamp, value] samples. The level on waking is the
   peak in the first hours of the day — it charges through the night and starts falling
   once you are up — so that is what "wake" means here. */
export function readBodyBattery(raw) {
  const r = flat(raw);
  const arr = Array.isArray(raw?.bodyBatteryValuesArray) ? raw.bodyBatteryValuesArray : [];
  const pts = arr.map((p) => (Array.isArray(p) ? [num(p[0]), num(p[1])] : null)).filter((p) => p && p[0] != null && p[1] != null);
  let wake = null, hi = null, lo = null;
  if (pts.length) {
    const t0 = pts[0][0];
    wake = Math.max(...pts.filter((p) => p[0] - t0 <= 10 * 36e5).map((p) => p[1]));
    hi = Math.max(...pts.map((p) => p[1])); lo = Math.min(...pts.map((p) => p[1]));
  }
  return {
    date: dateOf(r),
    bodyBatteryWake: wake ?? num(pick(r, ["wakeValue", "bodyBatteryAtWake", "endLevel"])),
    bodyBatteryHigh: hi ?? num(pick(r, ["highest", "maxLevel", "charged"])),
    bodyBatteryLow: lo ?? num(pick(r, ["lowest", "minLevel"])),
  };
}

export function readWeight(raw) {
  const r = flat(raw);
  const g = num(pick(r, ["weight", "weightInGrams"])) ?? num(r.latestWeight);
  return { date: dateOf(r), weightKg: g == null ? null : g > 400 ? Math.round(g) / 1000 : g };
}

export function readFitnessAge(raw) {
  const r = flat(raw);
  return { fitnessAge: num(pick(r, ["fitnessAge", "fitness_age", "currentFitnessAge"])), vo2: num(pick(r, ["vo2Max", "vo2max", "vo2MaxValue"])) };
}
