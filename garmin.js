/* Garmin Connect Personal API.

   Released 21 October 2026: free, read-only, pull-only, for your own account. You make a
   key in Garmin Connect settings, trade it for a 24-hour access token (there are no
   refresh tokens, so a fresh one is fetched each run), then call GET endpoints.

   What is documented with certainty: the token exchange. What is not: the exact path
   and parameter names of the 26 data endpoints, which the Swagger page lists but did not
   load when this was written. So nothing below assumes a path. Every endpoint is a
   candidate list tried in order, a 404 or 400 simply moves to the next, and the first
   that answers is remembered. The probe route reports what answered so the real paths
   can be pinned down once rather than guessed.

   Field names are the same story, so each reader takes the first of several plausible
   names and shrugs when none match. A missing field is an empty cell, never an error. */

import { env } from "./shared.js";

const TOKEN_URL = "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";
const BASES = [
  "https://personal.connectapi.garmin.com",
  "https://apis.garmin.com",
];

export const garminReady = () => !!env("GARMIN_PERSONAL_API_KEY");

/* A new 24-hour token every time; there is nothing to refresh. */
export async function getToken() {
  if (!garminReady()) throw new Error("GARMIN_PERSONAL_API_KEY is not set in Netlify");
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { Authorization: `ApiKey ${env("GARMIN_PERSONAL_API_KEY")}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Garmin refused the key (${r.status}). Make a new one at connect.garmin.com/app/settings/personalApiToken`);
  const token = j.access_token || j.accessToken || j.token;
  if (!token) throw new Error(`Garmin answered but sent no token: ${JSON.stringify(j).slice(0, 120)}`);
  return token;
}

/* Candidate paths per kind of data, in the order worth trying. Paths use {from}/{to} as
   unix seconds or {date} as YYYY-MM-DD, whichever the endpoint wants. */
export const CANDIDATES = {
  dailies: ["/wellness-api/rest/dailies", "/personal-api/rest/dailies", "/personal-api/dailies", "/usersummary-service/usersummary/daily"],
  sleeps: ["/wellness-api/rest/sleeps", "/personal-api/rest/sleeps", "/personal-api/sleeps", "/sleep-service/sleep/dailySleepData"],
  stress: ["/wellness-api/rest/stressDetails", "/personal-api/rest/stress", "/personal-api/stress", "/wellness-service/wellness/dailyStress"],
  hrv: ["/wellness-api/rest/hrv", "/personal-api/rest/hrv", "/personal-api/hrv", "/hrv-service/hrv"],
  bodyBattery: ["/wellness-api/rest/bodyBattery", "/personal-api/rest/bodyBattery", "/personal-api/body-battery"],
  heartRate: ["/wellness-api/rest/heartRate", "/personal-api/rest/heartRate", "/personal-api/heart-rate"],
  weight: ["/wellness-api/rest/bodyComps", "/personal-api/rest/weight", "/personal-api/weight", "/weight-service/weight/range"],
  fitnessAge: ["/personal-api/rest/fitnessAge", "/personal-api/fitness-age", "/fitnessage-service/fitnessage"],
  activities: ["/wellness-api/rest/activities", "/personal-api/rest/activities", "/personal-api/activities", "/activitylist-service/activities/search/activities"],
  spo2: ["/wellness-api/rest/pulseOx", "/personal-api/rest/pulseOx", "/personal-api/spo2"],
  respiration: ["/wellness-api/rest/allDayRespiration", "/personal-api/rest/respiration", "/personal-api/respiration"],
};

const day = (d) => d.toISOString().slice(0, 10);
const unix = (d) => Math.floor(d.getTime() / 1000);

/* Try each base × path × parameter style until something answers with data. */
export async function fetchKind(token, kind, from, to, remembered) {
  const paths = remembered ? [remembered, ...CANDIDATES[kind].filter((p) => p !== remembered)] : CANDIDATES[kind];
  const styles = [
    { startDate: day(from), endDate: day(to) },
    { uploadStartTimeInSeconds: unix(from), uploadEndTimeInSeconds: unix(to) },
    { start: day(from), end: day(to) },
    { from: day(from), to: day(to) },
    { date: day(to) },
  ];
  const tried = [];
  for (const base of BASES) {
    for (const path of paths) {
      for (const params of styles) {
        const url = `${base}${path}?${new URLSearchParams(params)}`;
        try {
          const r = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
          if (r.status === 401 || r.status === 403) { tried.push({ url, status: r.status }); continue; }
          if (!r.ok) { tried.push({ url, status: r.status }); continue; }
          const data = await r.json().catch(() => null);
          if (data == null) continue;
          const rows = Array.isArray(data) ? data : data.items || data.data || data.results || data[kind] || data[Object.keys(data)[0]];
          if (Array.isArray(rows) && rows.length) return { rows, path, base, params: Object.keys(params), tried };
          tried.push({ url, status: r.status, note: "empty" });
        } catch (e) { tried.push({ url, error: String(e.message || e) }); }
      }
    }
  }
  return { rows: [], path: null, tried };
}

/* ---- tolerant readers: first plausible name wins, nothing throws ---- */

const pick = (o, names) => { for (const n of names) if (o && o[n] != null && o[n] !== "") return o[n]; return null; };
/* Number(null) is 0 and Number("") is 0, which would turn every missing field into a
   real-looking zero. Only a genuine number counts, and objects like {value: 81} are
   unwrapped because Garmin nests some scores that way. */
const num = (v) => {
  if (v == null || v === "") return null;
  if (typeof v === "object") return num(v.value ?? v.score ?? v.overall ?? null);
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const mins = (v) => { const n = num(v); return n == null ? null : Math.round(n / 60); };
const dateOf = (r) => {
  const d = pick(r, ["calendarDate", "calendar_date", "date", "summaryDate", "sleepDate", "startDate"]);
  if (d) return String(d).slice(0, 10);
  const t = pick(r, ["startTimeInSeconds", "startTimeGMT", "startTimeLocal", "sleepStartTimestampLocal", "startTime"]);
  if (t == null) return null;
  const ms = typeof t === "number" ? (t > 1e12 ? t : t * 1000) : Date.parse(String(t).replace(" ", "T"));
  return Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 10) : null;
};

export function readSleep(r) {
  const direct = num(pick(r, ["sleepTimeSeconds", "durationInSeconds", "totalSleepSeconds", "sleepDurationInSeconds"]));
  // when no total is given, add the stages up
  const staged = ["deepSleepDurationInSeconds", "lightSleepDurationInSeconds", "remSleepInSeconds",
    "deepSleepSeconds", "lightSleepSeconds", "remSleepSeconds"].reduce((a, k) => a + (num(r?.[k]) || 0), 0);
  const secs = direct ?? (staged > 0 ? staged : null);
  const scoreObj = r?.sleepScores || r?.scores || {};
  const score = num(pick(r, ["overallSleepScore", "sleepScore", "overallScore"])) ?? num(scoreObj.overall) ?? num(scoreObj.overallScore);
  const startRaw = pick(r, ["sleepStartTimestampLocal", "startTimeLocal", "sleepStartLocal", "startTimeGMT"]);
  let bedtime = null;
  if (startRaw) {
    const m = String(startRaw).match(/[T ](\d{2}):(\d{2})/);
    if (m) bedtime = `${m[1]}:${m[2]}`;
  } else if (num(r?.startTimeInSeconds) != null) {
    // epoch seconds are UTC; apply the offset the record carries so it reads in local time
    const off = num(r?.startTimeOffsetInSeconds) ?? 0;
    const d = new Date((num(r.startTimeInSeconds) + off) * 1000);
    bedtime = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  return {
    date: dateOf(r),
    score, asleepMin: secs ? Math.round(secs / 60) : null,
    restingHr: num(pick(r, ["restingHeartRate", "restingHeartRateInBeatsPerMinute", "restingHR"])),
    bedtime,
    deepMin: mins(pick(r, ["deepSleepDurationInSeconds", "deepSleepSeconds"])),
    remMin: mins(pick(r, ["remSleepInSeconds", "remSleepSeconds"])),
    awakeMin: mins(pick(r, ["awakeDurationInSeconds", "awakeSleepSeconds"])),
    spo2: num(pick(r, ["averageSpO2Value", "avgSpo2", "averageSpO2"])),
    respiration: num(pick(r, ["averageRespirationValue", "avgRespiration", "averageRespiration"])),
  };
}

export function readDaily(r) {
  return {
    date: dateOf(r),
    steps: num(pick(r, ["steps", "totalSteps"])),
    restingHr: num(pick(r, ["restingHeartRateInBeatsPerMinute", "restingHeartRate", "restingHR"])),
    stressAvg: num(pick(r, ["averageStressLevel", "avgStressLevel", "stressAvg"])),
    stressMax: num(pick(r, ["maxStressLevel", "stressMax"])),
    bodyBatteryHigh: num(pick(r, ["bodyBatteryHighestValue", "bodyBatteryChargedValue"])),
    bodyBatteryLow: num(pick(r, ["bodyBatteryLowestValue"])),
    bodyBatteryWake: num(pick(r, ["bodyBatteryAtWakeTime", "bodyBatteryMostRecentValue"])),
    intensityMin: (() => {
      const mod = num(pick(r, ["moderateIntensityDurationInSeconds"])), vig = num(pick(r, ["vigorousIntensityDurationInSeconds"]));
      return mod == null && vig == null ? null : Math.round((mod || 0) / 60 + 2 * ((vig || 0) / 60));
    })(),
    floors: num(pick(r, ["floorsClimbed", "floors"])),
    calories: num(pick(r, ["activeKilocalories", "caloriesBurned", "totalKilocalories"])),
  };
}

export function readHrv(r) {
  return {
    date: dateOf(r),
    hrv: num(pick(r, ["lastNightAvg", "weeklyAvg", "hrvValue", "avgOvernightHrv", "overnightAvg"])),
    hrvStatus: pick(r, ["status", "hrvStatus"]),
  };
}

export function readBodyBattery(r) {
  return {
    date: dateOf(r),
    bodyBatteryWake: num(pick(r, ["wakeValue", "bodyBatteryAtWake", "bodyBatteryWake", "endLevel"])),
    bodyBatteryHigh: num(pick(r, ["highest", "maxLevel", "chargedValue"])),
    bodyBatteryLow: num(pick(r, ["lowest", "minLevel"])),
  };
}

export function readWeight(r) {
  const g = num(pick(r, ["weight", "weightInGrams"]));
  return { date: dateOf(r), weightKg: g == null ? null : g > 400 ? Math.round(g) / 1000 : g };
}

export function readFitnessAge(r) {
  return { date: dateOf(r), fitnessAge: num(pick(r, ["fitnessAge", "fitness_age", "age"])), vo2: num(pick(r, ["vo2Max", "vo2max", "vo2MaxValue"])) };
}
