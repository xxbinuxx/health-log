// Answers questions about your own log. The model never sees raw rows and never does
// arithmetic — it gets a compact set of figures we computed and explains them.
import { admin, env, json, userFromRequest } from "./lib/shared.js";
import { chat, groqReady } from "./lib/groq.js";
import {
  rollup, buildIndices, lastNDays, addDays, toDayKey, mondayOf, relToMedian,
  median, avg, sum, round, toUnit, secsToClock, fmtShort,
} from "../../scores.js";

const KEYS = { doses: "hl2:doses", sleep: "hl2:sleep", sessions: "hl2:sessions", days: "hl2:days", settings: "hl2:settings", spend: "hl2:spend" };

async function load(db, userId) {
  const { data } = await db.from("hl_store").select("key,value").eq("user_id", userId);
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return {
    doses: m[KEYS.doses] || [], sleep: m[KEYS.sleep] || [], sessions: m[KEYS.sessions] || [],
    days: m[KEYS.days] || [], spend: m[KEYS.spend] || [], settings: m[KEYS.settings] || {},
  };
}

/* A digest small enough to send, rich enough to answer from. */
export function digest(state, todayKey) {
  const s = { distanceUnit: "mi", weeklyDistanceTarget: 40, sleepHoursGoal: 7.5, dayStartHour: 4, ...state.settings };
  const u = s.distanceUnit;
  const daily = rollup({ ...state, settings: s });

  const window = (n) => {
    const span = lastNDays(n, todayKey);
    const rows = buildIndices(daily, span, s);
    const pick = (k) => rows.map((r) => r[k]).filter((v) => v != null);
    const days = span.map((k) => daily.get(k));
    const sleepScores = days.map((d) => d.sleep?.score).filter((v) => v != null);
    const rhr = days.map((d) => d.sleep?.restingHr).filter((v) => v != null);
    const paces = days.map((d) => d.paceSecKm).filter(Boolean);
    return {
      days: n,
      regen_median: round(median(pick("regen")), 1), stamina_median: round(median(pick("run")), 1),
      degen_median: round(median(pick("degen")), 1),
      sleep_score_avg: round(avg(sleepScores), 1), nights_logged: sleepScores.length,
      resting_hr_avg: round(avg(rhr), 1),
      miles_total: round(toUnit(sum(days.map((d) => d.runKm)), u), 1),
      runs: days.filter((d) => d.hasRun).length, lifts: days.filter((d) => d.hasLift).length,
      avg_pace: paces.length ? secsToClock(u === "mi" ? avg(paces) * 1.609344 : avg(paces)) : null,
      drinks_total: round(sum(days.map((d) => d.alc)), 1),
      thc_mg_total: round(sum(days.map((d) => d.thcMg)), 1),
      nicotine_mg_total: round(sum(days.map((d) => d.nicMg)), 1),
      caffeine_mg_per_day: round(avg(days.map((d) => d.caf)), 0),
      drinking_days: days.filter((d) => d.alc > 0).length,
      clean_days: days.filter((d) => !d.alc && !d.thc && !d.nic && !d.stim).length,
    };
  };

  // by weekday, over 90 days, since that is where most questions land
  const span90 = lastNDays(90, todayKey);
  const rows90 = buildIndices(daily, span90, s);
  const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const byDow = {};
  for (const r of rows90) {
    const d = daily.get(r.date);
    const name = DOW[new Date(`${r.date}T12:00:00`).getDay()];
    if (!byDow[name]) byDow[name] = { degen: [], regen: [], miles: [], drinks: [] };
    if (r.degen != null) byDow[name].degen.push(r.degen);
    if (r.regen != null) byDow[name].regen.push(r.regen);
    byDow[name].miles.push(toUnit(d.runKm, u));
    byDow[name].drinks.push(d.alc);
  }
  const weekday = {};
  for (const [k, v] of Object.entries(byDow)) {
    weekday[k] = {
      degen_median: round(median(v.degen), 1), regen_median: round(median(v.regen), 1),
      miles_avg: round(avg(v.miles), 1), drinks_avg: round(avg(v.drinks), 1),
    };
  }

  // what a heavy day costs the next morning
  const scored = span90.map((k) => ({ k, d: daily.get(k), prev: daily.get(addDays(k, -1)) }))
    .filter((x) => x.d.sleep?.score != null);
  const after = (test) => {
    const g = scored.filter((x) => test(x.prev)).map((x) => x.d.sleep.score);
    return g.length ? { nights: g.length, avg_sleep_score: round(avg(g), 1) } : null;
  };

  return {
    today: todayKey,
    units: { distance: u, weekly_distance_target: s.weeklyDistanceTarget, sleep_score_goal: s.sleepScoreGoal ?? 80 },
    last_7: window(7), last_30: window(30), last_90: window(90), last_365: window(365),
    by_weekday_90d: weekday,
    morning_after: {
      after_drinking: after((p) => p.alc > 0),
      after_heavy_night: after((p) => p.alc > 4.5 || p.thcMg > 5),
      after_dry_day: after((p) => !p.alc),
      after_training: after((p) => p.hasRun || p.hasLift),
    },
    note: "All figures are precomputed. Do not recalculate them.",
  };
}

const SYSTEM = `You answer questions about one person's own health and training log.

Rules:
1. Use only the figures in the JSON. Never calculate, estimate or infer a number that is not there. If the data cannot answer the question, say so plainly and name what is missing.
2. Quote figures exactly as given, with their units.
3. Two to five sentences. Direct and specific. No bullet points unless comparing three or more things.
4. Point out when a sample is small (under about 10 days) and the answer is therefore shaky.
5. Report intake factually. Do not moralise, do not diagnose, do not give medical advice.
6. If asked something the log has no bearing on, say that rather than guessing.`;

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!groqReady()) return json(503, { error: "Ask is not set up: no AI key is set in Netlify (AI_API_KEY or GROQ_API_KEY)." });

    const { question } = JSON.parse(event.body || "{}");
    if (!question || question.length < 3) return json(400, { error: "Ask a question." });
    if (question.length > 400) return json(400, { error: "That question is too long." });

    const state = await load(db, user.id);
    const d = digest(state, toDayKey(new Date()));
    const answer = await chat(SYSTEM, `Data:\n${JSON.stringify(d)}\n\nQuestion: ${question}`, { temperature: 0.3, maxTokens: 400 });
    return json(200, { answer });
  } catch (e) {
    console.error("ask:", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}
