import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import { store } from "./storage";
import { supabase } from "./supabase";
import { parseNotes } from "./notesImport";
import { parseRocketMoney, resolveBuckets, spendByDay, SPEND_BUCKETS, DEFAULT_SPEND_SETTINGS } from "./spendImport";
import { buildPlan, DEFAULT_PREFS, RACE_TYPES, raceType, bestFromRaces, parseTime } from "./plan";
import { MAJORS, windowStatus, actionable } from "./majors";
import {
  pad, KM_PER_MI, toUnit, fromUnit, round, clamp, avg, sum,
  toDayKey, fromDayKey, addDays, mondayOf, dayKeyFor, lastNDays,
  minsToHM, secsToClock, fmtShort, fmtDayLabel, median, quantile, relToMedian, pearson, paceSecOf,
  LAG_W, regenRaw, degenRaw, lagged, buildIndices, rollup, trainingLoad, staminaFrom,
} from "./scores";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar, ScatterChart, Scatter, ZAxis,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell, ComposedChart,
} from "recharts";

/* ================================================================== */
/* storage                                                            */
/* ================================================================== */

const KEYS = {
  doses: "hl2:doses", sleep: "hl2:sleep", sessions: "hl2:sessions",
  lifts: "hl2:lifts", days: "hl2:days", spend: "hl2:spend", plan: "hl2:plan", settings: "hl2:settings",
};

/* ================================================================== */
/* defaults                                                           */
/* ================================================================== */

const DEFAULT_SETTINGS = {
  dayStartHour: 4,
  distanceUnit: "mi",
  weightUnit: "lb",
  caffeineLimitMg: 400,
  drinksWeeklyLimit: 7,
  weeklyDistanceTarget: 40,
  sleepScoreGoal: 80,
  sleepHoursGoal: 7.5,
  stepsGoal: 8000,
  theme: "light",
  peerSocialMax: 150,
  planStart: null,
  races: [],
  planAdjust: [],
  planSwaps: [],
  priorRace: { time: "", distanceMi: 26.2, date: "" },
  planPrefs: { ...DEFAULT_PREFS },
  currency: "$",
  dayTags: ["normal", "social", "date", "travel", "work late", "sick", "family"],
  race: { name: "", date: "", goalTime: "", kind: "marathon" },
  presets: [
    { id: "c1", kind: "caffeine", label: "Americano", amount: 128, unit: "mg" },
    { id: "c2", kind: "caffeine", label: "Espresso", amount: 64, unit: "mg" },
    { id: "c3", kind: "caffeine", label: "Ultra", amount: 40, unit: "mg" },
    { id: "c4", kind: "caffeine", label: "Matcha", amount: 70, unit: "mg" },
    { id: "a1", kind: "alcohol", label: "Beer", amount: 1, unit: "drinks" },
    { id: "a2", kind: "alcohol", label: "Wine", amount: 1, unit: "drinks" },
    { id: "a3", kind: "alcohol", label: "Cocktail", amount: 1.5, unit: "drinks" },
    { id: "a4", kind: "alcohol", label: "Shot", amount: 1, unit: "drinks" },
    { id: "a5", kind: "alcohol", label: "Soju shot", amount: 1, unit: "drinks" },
    { id: "w1", kind: "cannabis", label: "Edible", amount: 10, unit: "mg", ask: true },
    { id: "w7", kind: "cannabis", label: "OffField", amount: 1.5, unit: "mg" },
    { id: "w3", kind: "cannabis", label: "Preroll", amount: 1, unit: "sessions" },
    { id: "w4", kind: "cannabis", label: "Bong hit", amount: 1, unit: "hits" },
    { id: "w5", kind: "cannabis", label: "Joint", amount: 1, unit: "sessions" },
    { id: "n1", kind: "nicotine", label: "Pouch", amount: 6, unit: "mg", ask: true },
    { id: "n2", kind: "nicotine", label: "Cigarette", amount: 1.5, unit: "mg" },
    { id: "n3", kind: "nicotine", label: "Vape", amount: 3, unit: "mg" },
    { id: "s1", kind: "stimulant", label: "Adderall", amount: 5, unit: "mg", ask: true },
  ],
};

const KIND_META = {
  caffeine: { color: "var(--caf)", name: "Caffeine" },
  alcohol: { color: "var(--alc)", name: "Alcohol" },
  cannabis: { color: "var(--thc)", name: "Cannabis" },
  nicotine: { color: "var(--nic)", name: "Nicotine" },
  stimulant: { color: "var(--stim)", name: "Adderall" },
};
const KIND_ORDER = ["caffeine", "alcohol", "cannabis", "nicotine", "stimulant"];

const RUN_TYPES = ["easy", "long", "tempo", "intervals", "race", "trail", "hike"];
const LIFT_TYPES = ["push", "pull", "legs", "upper", "lower", "full body"];
/* Three palettes. Light and dark use Okabe-Ito hues; high contrast goes neon on black.
   All three keep blue / green / magenta apart, which survives every common colour blindness. */
const PALETTES = {
  light: {
    paper: "#EEF2F7", card: "#FFFFFF", ink: "#0D1B30", soft: "#3D5171", faint: "#6B7F9B",
    rule: "#B9CADC", ruleSoft: "#DCE5EF", grid: "#DCE5EF", axis: "#3D5171", field: "#FFFFFF", head: "#F7FAFD",
    navy: "#12345E", sleep: "#0072B2", run: "#009E73", lift: "#E69F00", rest: "#767676",
    alert: "#D55E00", rhr: "#CC79A7", hours: "#56B4E9",
    caf: "#E69F00", alc: "#0072B2", thc: "#009E73", nic: "#4D4D4D", stim: "#CC79A7",
  },
  dark: {
    paper: "#0F1621", card: "#18212F", ink: "#E8EFF7", soft: "#A6B4C6", faint: "#7B8A9D",
    rule: "#2E3C50", ruleSoft: "#222D3E", grid: "#222D3E", axis: "#A6B4C6", field: "#101A27", head: "#1D2735",
    navy: "#7FB3FF", sleep: "#58A6FF", run: "#3DDC97", lift: "#F5B841", rest: "#8B98A9",
    alert: "#FF8A5B", rhr: "#E58FBF", hours: "#7FD3F7",
    caf: "#F5B841", alc: "#58A6FF", thc: "#3DDC97", nic: "#A6B4C6", stim: "#E58FBF",
  },
  contrast: {
    paper: "#000000", card: "#000000", ink: "#FFFFFF", soft: "#E6E6E6", faint: "#BDBDBD",
    rule: "#FFFFFF", ruleSoft: "#454545", grid: "#454545", axis: "#FFFFFF", field: "#000000", head: "#0D0D0D",
    navy: "#00D5FF", sleep: "#00D5FF", run: "#00FF85", lift: "#FFFFFF", rest: "#9E9E9E",
    alert: "#FF3CAC", rhr: "#FF3CAC", hours: "#7DF9FF",
    caf: "#FFE600", alc: "#00D5FF", thc: "#00FF85", nic: "#FFFFFF", stim: "#FF3CAC",
  },
};
const THEMES = [["light", "Light"], ["dark", "Dark"], ["contrast", "Contrast"]];
let CURRENT_THEME = "light";
// charts read plain JS colours, so this stays in step with whichever theme is on
const HEX = new Proxy({}, { get: (_t, k) => PALETTES[CURRENT_THEME][k] });
const kindHex = (kind) => HEX[{ caffeine: "caf", alcohol: "alc", cannabis: "thc", nicotine: "nic", stimulant: "stim" }[kind]];

/* ================================================================== */
/* helpers                                                            */
/* ================================================================== */

const uid = () => Math.random().toString(36).slice(2, 10);
const numOf = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return isNaN(n) ? null : n;
};

function fmtClock(ts) {
  const d = new Date(ts); let h = d.getHours();
  const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())}${ap}`;
}
function parsePace(v) {
  // "8:30" -> 510 sec; "8" -> 480; "8.5" -> 510
  if (!v) return null;
  const t = String(v).trim();
  if (t.includes(":")) { const [m, sec] = t.split(":").map(Number); return isNaN(m) ? null : m * 60 + (sec || 0); }
  const n = Number(t); return isNaN(n) || !n ? null : Math.round(n * 60);
}
/* bedtime as "HH:MM" 24h from "11:15pm", "23:15", "1115", "11pm" */
function parseBedtime(v) {
  if (!v) return null;
  const t = String(v).trim().toLowerCase().replace(/\s+/g, "");
  const m = t.match(/^(\d{1,2})(?::?(\d{2}))?(a|p)?m?$/);
  if (!m) return null;
  let h = Number(m[1]); const mm = Number(m[2] || 0);
  if (h > 23 || mm > 59) return null;
  const ap = m[3];
  if (ap === "p" && h < 12) h += 12;
  else if (ap === "a" && h === 12) h = 0;
  else if (!ap && h >= 7 && h <= 11) h += 12;   // "11:15" with no am/pm is an evening bedtime; "1:30" stays after midnight
  else if (!ap && h === 12) h = 0;               // "12" with no am/pm is midnight
  return `${pad(h)}:${pad(mm)}`;
}
/* minutes past noon, so 23:15 -> 675 and 00:30 -> 750; keeps averages sane across midnight */
function bedtimeMins(hhmm) {
  if (!hhmm) return null;
  const [h, m] = hhmm.split(":").map(Number);
  let mins = h * 60 + m - 12 * 60;
  if (mins < 0) mins += 24 * 60;
  return mins;
}
function fmtBedtime(mins) {
  if (mins == null || isNaN(mins)) return "—";
  let h = Math.floor(((mins + 12 * 60) % (24 * 60)) / 60); const m = Math.round(mins % 60);
  const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return `${h}:${pad(m)}${ap}`;
}
function parseGoalTime(str) {
  if (!str) return null;
  const p = String(str).split(":").map(Number);
  if (p.some(isNaN)) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return null;
}
function parseHours(v) {
  // "7.5" -> 450 min, "7:30" -> 450 min, "7h 30m" -> 450
  if (v == null || String(v).trim() === "") return null;
  const s = String(v).trim().toLowerCase();
  const hm = s.match(/(\d+)\s*h\s*(\d+)?/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2] || 0);
  if (s.includes(":")) { const [h, m] = s.split(":").map(Number); return (h || 0) * 60 + (m || 0); }
  const n = Number(s); return isNaN(n) ? null : n * 60;
}


function parseDuration(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1000 ? v / 60 : v;
  const s = String(v).trim().toLowerCase();
  const m = s.match(/(\d+)\s*h[a-z]*\s*(\d+)?\s*m?/);
  if (m) return Number(m[1]) * 60 + Number(m[2] || 0);
  if (s.includes(":")) {
    const p = s.split(":").map(Number);
    if (p.length === 3) return p[0] * 60 + p[1] + p[2] / 60;
    if (p.length === 2) return p[0] * 60 + p[1];
  }
  const n = Number(s.replace(/[^\d.]/g, ""));
  return isNaN(n) ? null : n > 1000 ? n / 60 : n;
}
function findCol(headers, cands) {
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const H = headers.map((h) => ({ raw: h, n: norm(h) }));
  for (const c of cands) { const e = H.find((h) => h.n === norm(c)); if (e) return e.raw; }
  for (const c of cands) { const e = H.find((h) => h.n.includes(norm(c))); if (e) return e.raw; }
  return null;
}
/* Garmin auto-titles runs "<Place> Running", so place names can't be trusted: "Long Island City" is not a long run. */
function inferRunType(name, distKm, activityType) {
  const s = String(name || "").toLowerCase();
  if (/\brace\b|5k|10k|half|marathon/.test(s)) return "race";
  if (/interval|repeat|\btrack\b|speed|fartlek|\d+\s*x\s*\d+/.test(s)) return "intervals";
  if (/tempo|threshold|progression/.test(s)) return "tempo";
  if (/long run|\blong\b(?! island)/.test(s)) return "long";
  if (/trail/.test(s) || /trail/i.test(activityType || "")) return "trail";
  if (distKm && distKm >= 16) return "long";
  return "easy";
}
function inferLiftType(name) {
  const s = String(name || "").toLowerCase();
  if (/push|chest|bench|shoulder/.test(s)) return "push";
  if (/pull|back|row|deadlift/.test(s)) return "pull";
  if (/leg|squat|lower/.test(s)) return /lower/.test(s) ? "lower" : "legs";
  if (/upper/.test(s)) return "upper";
  return "full body";
}
const isRunActivity = (t) => /run|jog|trail|treadmill/i.test(t || "");
const noonOf = (dayKey) => new Date(fromDayKey(dayKey).getTime() + 12 * 3600e3);

/* ================================================================== */
/* CSV parsing                                                        */
/* ================================================================== */

function parseGarminSleep(rows, headers) {
  const c = {
    date: findCol(headers, ["date", "day", "calendar date"]),
    score: findCol(headers, ["sleep score", "score", "overall"]),
    dur: findCol(headers, ["duration", "time asleep", "total sleep", "sleep time"]),
    rhr: findCol(headers, ["resting heart rate", "resting hr", "rhr"]),
    bb: findCol(headers, ["body battery"]),
    bed: findCol(headers, ["bedtime", "sleep start"]),
    vo2: findCol(headers, ["vo2 max", "vo2max", "vo2"]),
    fitAge: findCol(headers, ["fitness age", "fitnessage"]),
  };
  const out = [];
  for (const r of rows) {
    if (!c.date || !r[c.date]) continue;
    const d = new Date(String(r[c.date]).replace(/-/g, "/"));
    if (isNaN(d)) continue;
    const bedRaw = c.bed && r[c.bed] ? String(r[c.bed]).match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i) : null;
    out.push({
      date: toDayKey(d),
      score: c.score ? numOf(r[c.score]) : null,
      asleepMin: c.dur ? parseDuration(r[c.dur]) : null,
      restingHr: c.rhr ? numOf(r[c.rhr]) : null,
      bodyBattery: c.bb ? numOf(r[c.bb]) : null,
      bedtime: bedRaw ? parseBedtime(`${bedRaw[1]}:${bedRaw[2]}${bedRaw[3] || ""}`) : null,
      vo2: c.vo2 ? numOf(r[c.vo2]) : null,
      fitnessAge: c.fitAge ? numOf(r[c.fitAge]) : null,
    });
  }
  return out;
}

function parseStravaActivities(rows, headers) {
  const c = {
    date: findCol(headers, ["activity date", "date", "start date"]),
    name: findCol(headers, ["activity name", "name", "title"]),
    type: findCol(headers, ["activity type", "type", "sport"]),
    dist: findCol(headers, ["distance"]),
    moving: findCol(headers, ["moving time"]),
    elapsed: findCol(headers, ["elapsed time"]),
    id: findCol(headers, ["activity id", "id"]),
  };
  const out = [];
  for (const r of rows) {
    if (!c.date || !r[c.date]) continue;
    const d = new Date(String(r[c.date]).replace(/-/g, "/"));
    if (isNaN(d)) continue;
    const type = String(r[c.type] || "Run");
    if (!isRunActivity(type)) continue;
    const raw = numOf(r[c.dist]) ?? 0;
    const distKm = raw > 500 ? raw / 1000 : raw;
    const name = String(r[c.name] || "Run").slice(0, 80);
    out.push({
      id: r[c.id] ? `strava-${r[c.id]}` : uid(),
      date: toDayKey(d), ts: d.getTime(), kind: "run",
      type: inferRunType(name, distKm, type), name,
      distanceKm: round(distKm, 3),
      movingSec: numOf(r[c.moving]) ?? numOf(r[c.elapsed]),
      note: "", source: "strava",
    });
  }
  return out;
}

/* Garmin Connect > Activities > Export CSV. Distance arrives in whatever unit Garmin shows you, so we pass the unit in. */
function parseGarminActivities(rows, headers, unit) {
  const c = {
    date: findCol(headers, ["date", "start time", "start"]),
    type: findCol(headers, ["activity type", "type", "sport"]),
    name: findCol(headers, ["title", "activity name", "name"]),
    dist: findCol(headers, ["distance"]),
    time: findCol(headers, ["moving time", "time", "elapsed time", "duration"]),
    pace: findCol(headers, ["avg pace", "average pace", "pace"]),
  };
  if (!c.date) throw new Error("No date column found. Use the CSV from Garmin Connect's Activities page.");
  const out = [];
  for (const r of rows) {
    if (!r[c.date]) continue;
    const d = new Date(String(r[c.date]).replace(/-/g, "/"));
    if (isNaN(d)) continue;
    const type = String(r[c.type] || "Running");
    if (!isRunActivity(type)) continue;
    const distUnits = numOf(r[c.dist]) ?? 0;
    const distKm = fromUnit(distUnits, unit);
    let movingSec = c.time ? parseDuration(r[c.time]) : null;   // parseDuration returns minutes
    movingSec = movingSec != null ? Math.round(movingSec * 60) : null;
    const paceSec = c.pace ? parsePace(String(r[c.pace]).replace(/\s*\/.*$/, "")) : null;
    if (!movingSec && paceSec && distUnits) movingSec = Math.round(paceSec * distUnits);
    const name = String(r[c.name] || "Run").slice(0, 80);
    out.push({
      id: `garmin-${d.getTime()}`, date: toDayKey(d), ts: d.getTime(), kind: "run",
      type: inferRunType(name, distKm, type), name,
      distanceKm: round(distKm, 3), movingSec,
      paceSecPerKm: paceSec ? round(unit === "mi" ? paceSec / KM_PER_MI : paceSec, 1) : null,
      note: "", source: "garmin",
    });
  }
  return out;
}

function parseStrongCsv(rows, headers) {
  const c = {
    date: findCol(headers, ["date"]), workout: findCol(headers, ["workout name"]),
    ex: findCol(headers, ["exercise name", "exercise"]), weight: findCol(headers, ["weight"]),
    reps: findCol(headers, ["reps"]), order: findCol(headers, ["set order"]),
  };
  const out = [];
  for (const r of rows) {
    if (!c.date || !r[c.date]) continue;
    const d = new Date(String(r[c.date]).replace(/-/g, "/"));
    if (isNaN(d)) continue;
    const reps = numOf(r[c.reps]);
    if (!reps) continue;
    if (/warm/i.test(String(r[c.order] ?? ""))) continue;
    out.push({
      id: uid(), date: toDayKey(d), ts: d.getTime(),
      workout: String(r[c.workout] || "Workout"),
      exercise: String(r[c.ex] || "Exercise"),
      weight: numOf(r[c.weight]) ?? 0, reps,
    });
  }
  return out;
}

/* Strong sets become one lift session per (date, workout). Skipped when a manual lift already covers the day. */
function sessionsFromLifts(lifts, manualSessions) {
  const manualLiftDays = new Set(manualSessions.filter((s) => s.kind === "lift").map((s) => s.date));
  const groups = new Map();
  for (const l of lifts) {
    if (manualLiftDays.has(l.date)) continue;
    const k = `${l.date}|${l.workout}`;
    if (!groups.has(k)) groups.set(k, { id: `strong-${k}`, date: l.date, ts: l.ts, kind: "lift", type: inferLiftType(l.workout), name: l.workout, sets: 0, tonnage: 0, note: "", source: "strong" });
    const g = groups.get(k); g.sets += 1; g.tonnage += l.weight * l.reps;
  }
  return [...groups.values()];
}

function mergeBy(existing, incoming, keyFn) {
  const m = new Map(existing.map((r) => [keyFn(r), r]));
  for (const r of incoming) m.set(keyFn(r), { ...m.get(keyFn(r)), ...r });
  return [...m.values()];
}

/* ================================================================== */
/* styles                                                             */
/* ================================================================== */

const CSS = `
/* Okabe-Ito hues in light and dark; neon on black for contrast mode. */
.hl.t-light {
  --paper:#EEF2F7; --card:#FFFFFF; --ink:#0D1B30; --soft:#3D5171; --faint:#6B7F9B;
  --rule:#B9CADC; --rule-soft:#DCE5EF; --field:#FFFFFF; --head:#F7FAFD;
  --navy:#12345E; --sleep:#0072B2; --run:#009E73; --lift:#E69F00; --rest:#767676; --alert:#D55E00;
  --caf:#E69F00; --alc:#0072B2; --thc:#009E73; --nic:#4D4D4D; --stim:#CC79A7;
}
.hl.t-dark {
  --paper:#0F1621; --card:#18212F; --ink:#E8EFF7; --soft:#A6B4C6; --faint:#7B8A9D;
  --rule:#2E3C50; --rule-soft:#222D3E; --field:#101A27; --head:#1D2735;
  --navy:#7FB3FF; --sleep:#58A6FF; --run:#3DDC97; --lift:#F5B841; --rest:#8B98A9; --alert:#FF8A5B;
  --caf:#F5B841; --alc:#58A6FF; --thc:#3DDC97; --nic:#A6B4C6; --stim:#E58FBF;
}
.hl.t-contrast {
  --paper:#000000; --card:#000000; --ink:#FFFFFF; --soft:#E6E6E6; --faint:#BDBDBD;
  --rule:#FFFFFF; --rule-soft:#454545; --field:#000000; --head:#0D0D0D;
  --navy:#00D5FF; --sleep:#00D5FF; --run:#00FF85; --lift:#FFFFFF; --rest:#9E9E9E; --alert:#FF3CAC;
  --caf:#FFE600; --alc:#00D5FF; --thc:#00FF85; --nic:#FFFFFF; --stim:#FF3CAC;
}
.hl {
  background:var(--paper); color:var(--ink); min-height:100vh;
  font-family:Aptos,"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif;
  font-size:14px; line-height:1.45; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased;
}
.hl *,.hl *::before,.hl *::after{box-sizing:border-box;}
.hl .wrap{max-width:1080px;margin:0 auto;padding:20px 18px 64px;}
.hl header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;
  padding-bottom:12px;border-bottom:2px solid var(--navy);flex-wrap:wrap;}
.hl .brand{font-size:25px;font-weight:600;letter-spacing:-0.02em;color:var(--navy);}
.hl .brand span{color:var(--soft);font-weight:400;letter-spacing:0;}
.hl .race{text-align:right;font-size:12.5px;color:var(--soft);line-height:1.35;}
.hl .race b{display:block;font-size:22px;color:var(--navy);font-weight:600;letter-spacing:-0.02em;}
.hl nav{display:flex;gap:2px;margin:14px 0 18px;flex-wrap:wrap;}
.hl nav button{background:none;border:none;border-bottom:2px solid transparent;padding:6px 12px;
  font:inherit;font-size:13.5px;color:var(--soft);cursor:pointer;}
.hl nav button:hover{color:var(--ink);}
.hl nav button[aria-current="true"]{color:var(--navy);font-weight:600;border-bottom-color:var(--navy);}
.hl nav button:focus-visible,.hl button:focus-visible{outline:2px solid var(--sleep);outline-offset:2px;}
.hl .panel{background:var(--card);border:1px solid var(--rule);margin-bottom:14px;}
.hl .panel{border-radius:3px;}
.hl .panel > h2{margin:0;padding:9px 14px;font-size:12.5px;font-weight:600;color:var(--navy);
  background:var(--head);border-bottom:1px solid var(--rule-soft);display:flex;justify-content:space-between;align-items:center;gap:10px;}
.hl .panel > h2 .hint{font-weight:400;color:var(--faint);}
.hl .panel .body{padding:14px;}
.hl .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.hl .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.hl .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;row-gap:18px;}
@media(max-width:820px){.hl .grid4{grid-template-columns:repeat(2,1fr);}}
@media(max-width:760px){.hl .grid2,.hl .grid3{grid-template-columns:1fr;}}
.hl .stat{display:flex;flex-direction:column;gap:1px;}
.hl .stat .v{font-size:27px;line-height:1.15;font-weight:600;letter-spacing:-0.02em;}
.hl .stat .v.sm{font-size:21px;}
.hl .stat .l{font-size:11.5px;color:var(--faint);}
.hl .stat .sub{font-size:11.5px;color:var(--soft);}
.hl .daynav{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
.hl .daynav b{font-weight:500;font-size:15px;min-width:150px;}
.hl button.ghost{background:none;border:1px solid var(--rule);color:var(--soft);padding:3px 9px;
  font:inherit;font-size:12px;cursor:pointer;border-radius:2px;}
.hl button.ghost:hover:not(:disabled){border-color:var(--ink);color:var(--ink);}
.hl button.ghost:disabled{opacity:.4;cursor:default;}
.hl .chips{display:flex;flex-wrap:wrap;gap:6px;}
.hl .chip{border:1px solid var(--rule);background:var(--field);border-radius:2px;padding:6px 10px;
  font:inherit;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:7px;transition:transform .08s ease;}
.hl .chip:hover{border-color:currentColor;}
.hl .chip:active{transform:scale(.96);}
.hl .chip .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;}
.hl .chip .amt{color:var(--faint);font-size:11px;}
.hl .chip span.lbl{color:var(--ink);}
.hl .chip.caffeine{color:var(--caf);} .hl .chip.alcohol{color:var(--alc);}
.hl .chip.cannabis{color:var(--thc);} .hl .chip.nicotine{color:var(--nic);} .hl .chip.stimulant{color:var(--stim);}
.hl .chip[aria-pressed="true"]{border-color:currentColor;background:var(--paper);}
.hl .seg{display:inline-flex;border:1px solid var(--rule);border-radius:2px;overflow:hidden;}
.hl .seg button{background:var(--field);border:none;border-right:1px solid var(--rule);padding:6px 14px;font:inherit;
  font-size:13px;color:var(--soft);cursor:pointer;}
.hl .seg button:last-child{border-right:none;}
.hl .seg button[aria-pressed="true"]{background:var(--navy);color:var(--paper);font-weight:600;}
.hl .seg button.run[aria-pressed="true"]{background:var(--run);}
.hl .seg button.lift[aria-pressed="true"]{background:var(--lift);}
.hl .seg button.rest[aria-pressed="true"]{background:var(--soft);}
.hl .tchip{border:1px solid var(--rule);background:var(--field);border-radius:14px;padding:4px 11px;font:inherit;
  font-size:12.5px;color:var(--soft);cursor:pointer;}
.hl .tchip[aria-pressed="true"]{border-color:currentColor;color:var(--ink);background:var(--paper);}
.hl .tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;color:var(--paper);line-height:1.5;}
.hl .tag.run{background:var(--run);} .hl .tag.lift{background:var(--lift);} .hl .tag.rest{background:var(--rest);}
.hl .done{display:flex;gap:14px;font-size:12px;color:var(--soft);}
.hl .done span::before{content:"";display:inline-block;width:8px;height:8px;border-radius:50%;
  border:1.5px solid var(--faint);margin-right:6px;vertical-align:-1px;}
.hl .done span.yes::before{background:var(--lift);border-color:var(--lift);}
.hl table{width:100%;border-collapse:collapse;font-size:12.5px;}
.hl th{text-align:left;font-weight:500;color:var(--faint);font-size:11px;padding:4px 8px 4px 0;
  border-bottom:1px solid var(--rule);}
.hl td{padding:5px 8px 5px 0;border-bottom:1px solid var(--rule-soft);vertical-align:top;}
.hl td.num,.hl th.num{text-align:right;padding-right:0;}
.hl tr:last-child td{border-bottom:none;}
.hl .del{background:none;border:none;color:var(--faint);cursor:pointer;font:inherit;font-size:14px;line-height:1;padding:0 2px;}
.hl .del:hover{color:var(--alert);}
.hl input,.hl select,.hl textarea{font:inherit;font-size:13px;padding:5px 7px;border:1px solid var(--rule);
  background:var(--field);color:var(--ink);border-radius:2px;width:100%;}
.hl input::placeholder,.hl textarea::placeholder{color:var(--faint);}
.hl input:focus,.hl select:focus,.hl textarea:focus{outline:2px solid var(--sleep);outline-offset:-1px;}
.hl input.big{font-size:21px;font-weight:600;letter-spacing:-0.01em;padding:6px 8px;}
.hl label.f{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--soft);}
.hl .row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;}
.hl button.solid{background:var(--navy);color:var(--paper);border:none;padding:7px 14px;font:inherit;
  font-size:13px;font-weight:500;cursor:pointer;border-radius:3px;}
.hl button.solid:hover{filter:brightness(1.15);}
.hl button.solid:disabled{opacity:.4;cursor:default;background:var(--navy);}
.hl button.danger{border:1px solid var(--alert);color:var(--alert);background:none;padding:6px 12px;
  font:inherit;font-size:12.5px;cursor:pointer;border-radius:2px;}
.hl .note{font-size:12px;color:var(--soft);line-height:1.5;}
.hl .flag{color:var(--alert);} .hl .ok{color:var(--lift);}
.hl .empty{color:var(--faint);font-size:12.5px;padding:10px 0;}
.hl .bar-track{height:5px;background:var(--rule-soft);border-radius:3px;overflow:hidden;margin-top:5px;}
.hl .bar-fill{height:100%;border-radius:3px;}
.hl .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--soft);margin-top:8px;}
.hl .legend i{display:inline-block;width:9px;height:9px;margin-right:5px;border-radius:2px;vertical-align:-1px;}
.hl .divline{height:1px;background:var(--rule-soft);margin:14px 0;}
.hl .saved{font-size:11.5px;color:var(--lift);}
.hl .tag.stim{background:var(--stim);}
.hl .pill{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;background:var(--rule-soft);color:var(--soft);}
.hl .calwrap{overflow-x:auto;overflow-y:visible;}
.hl table.cal{table-layout:fixed;width:100%;min-width:680px;border-collapse:separate;border-spacing:0;}
/* every day column the same width, whatever the range */
.hl table.cal col.daycol{width:12.4%;}
.hl table.cal col.wkcol{width:7.4%;}
.hl table.cal col.micol{width:6.6%;}
.hl table.cal thead th{position:sticky;top:0;z-index:2;background:var(--card);
  text-align:center;font-size:10.5px;padding:5px 2px;border-bottom:1px solid var(--rule);}
.hl .cell{border:1px solid var(--rule-soft);padding:4px 3px;vertical-align:top;cursor:pointer;
  height:62px;overflow:hidden;}
.hl .cell:hover{border-color:var(--rule);}
.hl .cell.today{outline:2px solid var(--navy);outline-offset:-2px;}
.hl .cell.empty-cell{background:var(--paper);cursor:default;}
.hl .cell .dnum{font-size:10px;color:var(--faint);line-height:1.2;}
.hl .cell .dtitle{font-size:12px;font-weight:600;letter-spacing:-0.01em;line-height:1.25;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.hl .cell .dsub{font-size:10px;color:var(--soft);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:1.3;}
.hl .cell .dmark{font-size:10px;margin-top:1px;line-height:1.2;white-space:nowrap;}
/* the first row of a new month gets a rule, so long ranges stay readable */
.hl tr.newmonth td{border-top:2px solid var(--rule);}
.hl td.wklabel{font-size:10.5px;color:var(--faint);line-height:1.3;padding:4px 4px 4px 0;vertical-align:top;}
.hl td.wklabel b{display:block;color:var(--soft);font-weight:600;}
.hl td.wkmiles{font-size:11.5px;text-align:right;padding:4px 0;vertical-align:top;line-height:1.35;}
.hl .cell .dmark.done{color:var(--run);} .hl .cell .dmark.short{color:var(--lift);}
.hl .cell .dmark.missed{color:var(--alert);} .hl .cell .dmark.extra{color:var(--sleep);}
.hl .chatbox{max-height:280px;overflow-y:auto;margin-bottom:12px;display:flex;flex-direction:column;gap:8px;}
.hl .bubble{padding:8px 11px;border-radius:10px;font-size:13.5px;line-height:1.5;max-width:88%;}
.hl .bubble.user{align-self:flex-end;background:var(--navy);color:var(--paper);border-bottom-right-radius:3px;}
.hl .bubble.coach{align-self:flex-start;background:var(--rule-soft);color:var(--ink);border-bottom-left-radius:3px;}
.hl .bubble.err{background:none;border:1px solid var(--alert);color:var(--alert);}
.hl .cell[draggable="true"]{cursor:grab;}
.hl .cell[draggable="true"]:active{cursor:grabbing;}
.hl .cell.dragging{opacity:.45;border-style:dashed;}
.hl .cell.moved{border-color:var(--navy);}
.hl .cell.raceday{outline:2px solid var(--alert);outline-offset:-2px;background:color-mix(in srgb, var(--alert) 8%, transparent);}
.hl .cell.past{background:color-mix(in srgb, var(--paper) 60%, transparent);}
.hl tr.pastweek td{opacity:.85;}
@media(max-width:700px){.hl .cell{height:56px;padding:3px 2px;} .hl .cell .dsub{display:none;}
  .hl table.cal{min-width:600px;} .hl .cell .dtitle{font-size:11px;}}
.hl .scorerow{display:grid;grid-template-columns:minmax(160px,210px) 1fr;gap:18px;align-items:start;}
@media(max-width:700px){.hl .scorerow{grid-template-columns:1fr;}}
.hl .rangebar{display:flex;justify-content:flex-end;margin:-6px 0 14px;}
.hl .rangebar .seg button{padding:5px 12px;font-size:12.5px;}
@media(max-width:600px){.hl .rangebar{justify-content:stretch;} .hl .rangebar .seg{display:flex;width:100%;} .hl .rangebar .seg button{flex:1;padding:6px 4px;}}
.hl .rc-tip{background:var(--card);border:1px solid var(--rule);padding:6px 9px;font-size:12px;color:var(--ink);}
.hl .rc-tip b{display:block;color:var(--soft);font-weight:500;margin-bottom:2px;}
.hl.t-contrast .panel{border-width:2px;}
.hl.t-contrast .panel > h2{border-bottom-width:2px;}
.hl.t-contrast .stat .v{font-weight:700;}
.hl.t-contrast .legend{color:var(--ink);}
.hl.t-contrast button.ghost{border-width:2px;color:var(--ink);}
.hl .themepick{display:flex;gap:8px;align-items:center;justify-content:flex-end;}
.hl .themepick .seg button{padding:3px 9px;font-size:11.5px;}
@media (prefers-reduced-motion:reduce){.hl *{transition:none!important;}}
`;

/* ================================================================== */
/* small shared bits                                                  */
/* ================================================================== */

/* Calls one of our Netlify functions with the signed-in session attached. */
async function callFn(path, { method = "GET", body } = {}) {
  const { data } = await supabase.auth.getSession();
  const r = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${data.session?.access_token ?? ""}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = await r.json().catch(() => ({ error: "The server did not reply. Is the latest version deployed?" }));
  if (!r.ok || j.error) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}

/* One panel throwing must not take the whole app down — especially between deploys. */
class Boundary extends React.Component {
  constructor(p) { super(p); this.state = { err: null }; }
  static getDerivedStateFromError(err) { return { err }; }
  componentDidCatch(err, info) { console.error("panel crashed:", this.props.where, err, info); }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="panel" style={{ borderColor: "var(--alert)" }}>
        <h2 style={{ color: "var(--alert)" }}>{this.props.where || "This section"} could not be drawn</h2>
        <div className="body">
          <p className="note">
            Everything else still works, and nothing you have logged is affected. Switching the range or
            the tab often clears it.
          </p>
          <p className="note" style={{ marginTop: 8, color: "var(--faint)" }}>{String(this.state.err?.message || this.state.err)}</p>
          <button className="ghost" style={{ marginTop: 10 }} onClick={() => this.setState({ err: null })}>Try again</button>
        </div>
      </div>
    );
  }
}

function Stat({ v, l, sub, color, bar }) {
  return (
    <div className="stat">
      <span className="v" style={color ? { color } : undefined}>{v ?? "—"}</span>
      <span className="l">{l}</span>
      {sub != null && <span className="sub">{sub}</span>}
      {bar != null && (
        <div className="bar-track">
          <div className="bar-fill" style={{ width: `${Math.min(100, bar.pct)}%`, background: bar.color }} />
        </div>
      )}
    </div>
  );
}

function Tip({ active, payload, label, fmt }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rc-tip">
      <b>{label}</b>
      {payload.filter((p) => p.value != null).map((p, i) => (
        <div key={i}>{p.name}: {fmt ? fmt(p) : p.value}</div>
      ))}
    </div>
  );
}

const axisTick = () => ({ fontSize: 11, fill: HEX.axis });

function Chart({ h = 180, children }) {
  return <div style={{ width: "100%", height: h }}><ResponsiveContainer>{children}</ResponsiveContainer></div>;
}


/* ================================================================== */
/* Log — the one-sheeter                                              */
/* ================================================================== */

/* Say what you did; confirm what it heard. Nothing is written until you accept it. */
function VoiceLog({ dayKey, settings, onApply }) {
  const [state, setState] = useState("idle");   // idle | recording | working | review | error
  const [msg, setMsg] = useState("");
  const [result, setResult] = useState(null);
  const rec = useRef(null), chunks = useRef([]);

  const supported = typeof window !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

  const stop = () => { try { rec.current?.stop(); } catch {} };

  const start = async () => {
    setMsg(""); setResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/mp4";
      const r = new MediaRecorder(stream, { mimeType: mime });
      chunks.current = [];
      r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState("working");
        try {
          const blob = new Blob(chunks.current, { type: mime });
          const b64 = await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(String(fr.result).split(",")[1]);
            fr.onerror = rej; fr.readAsDataURL(blob);
          });
          const j = await callFn("/.netlify/functions/voice-log", {
            method: "POST",
            body: { audio: b64, mime, unit: settings.distanceUnit, presets: settings.presets },
          });
          if (!j.parsed) { setState("error"); setMsg(j.error || "Nothing was heard."); return; }
          setResult(j); setState("review");
        } catch (e) { setState("error"); setMsg(String(e.message || e)); }
      };
      rec.current = r; r.start(); setState("recording");
      setTimeout(() => { if (r.state === "recording") r.stop(); }, 60000);   // hard stop at a minute
    } catch (e) { setState("error"); setMsg("Could not reach the microphone. Check the browser's permission."); }
  };

  if (!supported) return null;

  const p = result?.parsed;
  const nothing = p && !p.intake?.length && !p.workout && !p.sleep && !p.tags?.length && !p.note;

  return (
    <div className="panel">
      <h2>Say it <span className="hint">speak a sentence; you confirm before anything is saved</span></h2>
      <div className="body">
        {state !== "review" && (
          <>
            <div className="row">
              {state === "recording" ? (
                <button className="solid" onClick={stop} style={{ background: "var(--alert)" }}>Stop and read it back</button>
              ) : (
                <button className="solid" onClick={start} disabled={state === "working"}>
                  {state === "working" ? "Listening back…" : "Record"}
                </button>
              )}
              <span className="note" style={{ color: state === "error" ? "var(--alert)" : "var(--soft)" }}>
                {state === "recording" ? "Recording — tap stop when you're done."
                  : state === "working" ? "Transcribing…"
                  : msg || "Try: two beers, a zyn, ran six miles easy at eight thirty pace."}
              </span>
            </div>
          </>
        )}

        {state === "review" && p && (
          <>
            <p className="note" style={{ marginBottom: 10 }}>Heard: <span style={{ color: "var(--ink)" }}>"{result.transcript}"</span></p>
            {nothing ? <p className="empty">Nothing in that mapped to an entry.</p> : (
              <table style={{ marginBottom: 10 }}>
                <tbody>
                  {p.sleep && (p.sleep.score != null || p.sleep.hours != null) && (
                    <tr><td style={{ width: 88, color: "var(--soft)" }}>sleep</td>
                      <td>{[p.sleep.score != null ? `score ${p.sleep.score}` : null, p.sleep.hours != null ? `${p.sleep.hours}h` : null,
                           p.sleep.restingHr != null ? `RHR ${p.sleep.restingHr}` : null, p.sleep.bodyBattery != null ? `battery ${p.sleep.bodyBattery}` : null,
                           p.sleep.bedtime || null].filter(Boolean).join(" · ")}</td></tr>
                  )}
                  {p.workout && (
                    <tr><td style={{ color: "var(--soft)" }}>workout</td>
                      <td><span className={`tag ${p.workout.kind}`}>{p.workout.type || p.workout.kind}</span>{" "}
                        {[p.workout.distance ? `${p.workout.distance} ${settings.distanceUnit}` : null, p.workout.pace || null, p.workout.note || null].filter(Boolean).join(" · ")}</td></tr>
                  )}
                  {(p.intake || []).map((i, n) => (
                    <tr key={n}><td style={{ color: "var(--soft)" }}>{n === 0 ? "intake" : ""}</td>
                      <td><span style={{ color: KIND_META[i.kind]?.color, marginRight: 6 }}>●</span>{i.label} — {i.amount} {i.unit}</td></tr>
                  ))}
                  {(p.tags?.length || p.note) && (
                    <tr><td style={{ color: "var(--soft)" }}>day</td>
                      <td>{(p.tags || []).map((t) => <span key={t} className="tag" style={{ background: "var(--sleep)", marginRight: 4 }}>{t}</span>)}{p.note}</td></tr>
                  )}
                </tbody>
              </table>
            )}
            {p.unclear?.length > 0 && (
              <p className="note flag" style={{ marginBottom: 10 }}>Assumed: {p.unclear.join(" · ")}</p>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button className="solid" onClick={() => { onApply(p); setState("idle"); setResult(null); }} disabled={nothing}>
                Add to {dayKey === toDayKey(new Date()) ? "today" : fmtShort(dayKey)}
              </button>
              <button className="ghost" onClick={() => { setState("idle"); setResult(null); }}>Discard</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Log({ dayKey, setDayKey, doses, sleep, sessions, days, settings, addDose, removeDose, upsertSleep, addSession, removeSession, upsertDay }) {
  const today = toDayKey(new Date());
  const yesterday = addDays(today, -1);
  const isToday = dayKey === today;

  const dayDoses = doses.filter((d) => dayKeyFor(d.ts, settings.dayStartHour) === dayKey)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const sleepRec = sleep.find((s) => s.date === dayKey);
  const daySessions = sessions.filter((s) => s.date === dayKey);
  const dayRec = days.find((d) => d.date === dayKey);

  /* ---- sleep fields: local draft, commit on blur / Enter ---- */
  const [score, setScore] = useState("");
  const [hours, setHours] = useState("");
  const [rhr, setRhr] = useState("");
  const [bb, setBb] = useState("");
  const [bed, setBed] = useState("");
  useEffect(() => {
    setScore(sleepRec?.score ?? "");
    setHours(sleepRec?.asleepMin != null ? String(round(sleepRec.asleepMin / 60, 2)) : "");
    setRhr(sleepRec?.restingHr ?? "");
    setBb(sleepRec?.bodyBattery ?? "");
    setBed(sleepRec?.bedtime ? fmtBedtime(bedtimeMins(sleepRec.bedtime)) : "");
  }, [dayKey, sleepRec?.score, sleepRec?.asleepMin, sleepRec?.restingHr, sleepRec?.bodyBattery, sleepRec?.bedtime]);

  const commitSleep = () => {
    const rec = { date: dayKey, score: numOf(score), asleepMin: parseHours(hours), restingHr: numOf(rhr), bodyBattery: numOf(bb), bedtime: parseBedtime(bed) };
    const empty = Object.keys(rec).every((k) => k === "date" || rec[k] == null);
    if (empty && !sleepRec) return;
    upsertSleep(rec);
  };
  const onEnter = (e) => { if (e.key === "Enter") e.currentTarget.blur(); };

  /* ---- day fields: tags toggle at once, note and steps commit on blur ---- */
  const [note, setNote] = useState("");
  const [steps, setSteps] = useState("");
  useEffect(() => { setNote(dayRec?.note ?? ""); setSteps(dayRec?.steps ?? ""); }, [dayKey, dayRec?.note, dayRec?.steps]);
  const tags = dayRec?.tags || [];
  const toggleTag = (t) => upsertDay({ date: dayKey, tags: tags.includes(t) ? tags.filter((x) => x !== t) : [...tags, t] });
  const commitDay = () => upsertDay({ date: dayKey, note: note.trim(), steps: numOf(steps) });
  const dayDone = tags.length > 0 || !!dayRec?.note || dayRec?.steps != null;

  /* ---- workout draft ---- */
  const [wKind, setWKind] = useState("run");
  const [wType, setWType] = useState("easy");
  const [wDist, setWDist] = useState("");
  const [wPace, setWPace] = useState("");
  const [wNote, setWNote] = useState("");
  const pickKind = (k) => { setWKind(k); setWType(k === "run" ? "easy" : k === "lift" ? "push" : ""); };

  const addWorkout = () => {
    const ts = noonOf(dayKey).getTime();
    const base = { id: uid(), date: dayKey, ts, kind: wKind, type: wType, note: wNote.trim(), source: "manual" };
    if (wKind === "run") {
      const distUnits = wDist ? Number(wDist) || 0 : null;
      const distKm = distUnits ? fromUnit(distUnits, settings.distanceUnit) : null;
      const paceSec = parsePace(wPace);                       // seconds per current unit
      const paceSecPerKm = paceSec ? (settings.distanceUnit === "mi" ? paceSec / KM_PER_MI : paceSec) : null;
      addSession({
        ...base, name: `${wType[0].toUpperCase()}${wType.slice(1)} run`,
        distanceKm: distKm ? round(distKm, 3) : null,
        movingSec: paceSec && distUnits ? Math.round(paceSec * distUnits) : null,
        paceSecPerKm: paceSecPerKm ? round(paceSecPerKm, 1) : null,
      });
    } else if (wKind === "lift") {
      addSession({ ...base, name: `${wType[0].toUpperCase()}${wType.slice(1)} day` });
    } else {
      addSession({ ...base, name: "Rest day" });
    }
    setWDist(""); setWPace(""); setWNote("");
  };

  /* ---- intake ---- */
  const [open, setOpen] = useState(false);
  const [cKind, setCKind] = useState("caffeine");
  const [cLabel, setCLabel] = useState("");
  const [cAmt, setCAmt] = useState("");
  const [cUnit, setCUnit] = useState("mg");
  const [cTime, setCTime] = useState("");

  const [pending, setPending] = useState(null);   // a chip waiting for its mg
  const [pendingAmt, setPendingAmt] = useState("");
  const stamp = () => (isToday ? new Date() : noonOf(dayKey));
  const logDose = (p, amount) => addDose({ id: uid(), ts: stamp().toISOString(), kind: p.kind, label: p.label, amount, unit: p.unit });
  const logPreset = (p) => {
    if (p.ask) { setPending(p); setPendingAmt(""); return; }
    logDose(p, p.amount);
  };
  const logPending = () => {
    const amt = Number(pendingAmt);
    if (!pending || !amt) return;
    logDose(pending, amt); setPending(null); setPendingAmt("");
  };
  const addCustom = () => {
    const amt = Number(cAmt);
    if (!amt || !cLabel.trim()) return;
    let ts;
    if (cTime) {
      const [h, m] = cTime.split(":").map(Number);
      const base = fromDayKey(dayKey);
      if (h < settings.dayStartHour) base.setDate(base.getDate() + 1);
      base.setHours(h, m, 0, 0); ts = base;
    } else ts = stamp();
    addDose({ id: uid(), ts: ts.toISOString(), kind: cKind, label: cLabel.trim(), amount: amt, unit: cUnit });
    setCLabel(""); setCAmt(""); setCTime("");
  };

  // everything the voice note produced goes through the same writers as the buttons do
  const applyVoice = (p) => {
    for (const i of p.intake || []) {
      if (!i || !KIND_META[i.kind] || !i.amount) continue;
      addDose({ id: uid(), ts: stamp().toISOString(), kind: i.kind, label: String(i.label || i.kind).slice(0, 60),
        amount: Number(i.amount), unit: i.unit || "mg" });
    }
    if (p.workout?.kind) {
      const w = p.workout;
      const ts = noonOf(dayKey).getTime();
      const base = { id: uid(), date: dayKey, ts, kind: w.kind, type: w.type || "", note: (w.note || "").slice(0, 120), source: "manual" };
      if (w.kind === "run") {
        const distUnits = Number(w.distance) || null;
        const distKm = distUnits ? fromUnit(distUnits, settings.distanceUnit) : null;
        const paceSec = parsePace(w.pace);
        addSession({ ...base, name: `${(w.type || "Easy")} run`,
          distanceKm: distKm ? round(distKm, 3) : null,
          movingSec: paceSec && distUnits ? Math.round(paceSec * distUnits) : null,
          paceSecPerKm: paceSec ? round(settings.distanceUnit === "mi" ? paceSec / KM_PER_MI : paceSec, 1) : null });
      } else if (w.kind === "lift") addSession({ ...base, name: `${w.type || "Lift"} day` });
      else addSession({ ...base, name: "Rest day" });
    }
    if (p.sleep && (p.sleep.score != null || p.sleep.hours != null || p.sleep.restingHr != null || p.sleep.bodyBattery != null || p.sleep.bedtime)) {
      upsertSleep({ date: dayKey,
        score: p.sleep.score ?? sleepRec?.score ?? null,
        asleepMin: p.sleep.hours != null ? Math.round(Number(p.sleep.hours) * 60) : sleepRec?.asleepMin ?? null,
        restingHr: p.sleep.restingHr ?? sleepRec?.restingHr ?? null,
        bodyBattery: p.sleep.bodyBattery ?? sleepRec?.bodyBattery ?? null,
        bedtime: p.sleep.bedtime ? parseBedtime(p.sleep.bedtime) : sleepRec?.bedtime ?? null });
    }
    if (p.tags?.length || p.note) {
      const known = (p.tags || []).filter((t) => settings.dayTags.includes(t));
      upsertDay({ date: dayKey, tags: [...new Set([...tags, ...known])], note: p.note ? String(p.note).slice(0, 200) : dayRec?.note || "" });
    }
  };

  const sumKind = (k) => dayDoses.filter((d) => d.kind === k).reduce((a, b) => a + b.amount, 0);
  const caf = sumKind("caffeine"), alc = sumKind("alcohol");
  const thcN = dayDoses.filter((d) => d.kind === "cannabis").length;
  const nicN = dayDoses.filter((d) => d.kind === "nicotine").length;

  const sleepDone = sleepRec && (sleepRec.score != null || sleepRec.asleepMin != null);
  const dayLabel = isToday ? "Today" : dayKey === yesterday ? "Yesterday" : fmtDayLabel(dayKey);

  return (
    <>
      <div className="panel">
        <div className="body" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, padding: "10px 14px" }}>
          <div className="daynav">
            <button className="ghost" onClick={() => setDayKey(addDays(dayKey, -1))}>←</button>
            <b>{dayLabel}</b>
            <button className="ghost" onClick={() => setDayKey(addDays(dayKey, 1))} disabled={isToday}>→</button>
            {dayKey !== yesterday && <button className="ghost" onClick={() => setDayKey(yesterday)}>Yesterday</button>}
            {!isToday && <button className="ghost" onClick={() => setDayKey(today)}>Today</button>}
            <input type="date" value={dayKey} max={today} onChange={(e) => e.target.value && setDayKey(e.target.value)} style={{ width: 150 }} />
          </div>
          <div className="done">
            <span className={sleepDone ? "yes" : ""}>Sleep</span>
            <span className={daySessions.length ? "yes" : ""}>Workout</span>
            <span className={dayDone ? "yes" : ""}>Day</span>
            <span className={dayDoses.length ? "yes" : ""}>Intake{dayDoses.length ? ` (${dayDoses.length})` : ""}</span>
          </div>
        </div>
      </div>

      <div className="grid2">
        {/* ---------------- Sleep ---------------- */}
        <div className="panel">
          <h2>Sleep <span className="hint">the night ending this morning</span></h2>
          <div className="body">
            <div className="row">
              <label className="f" style={{ width: 110 }}>Garmin score
                <input className="big" value={score} inputMode="numeric" placeholder="82"
                       onChange={(e) => setScore(e.target.value)} onBlur={commitSleep} onKeyDown={onEnter} />
              </label>
              <label className="f" style={{ width: 110 }}>Hours asleep
                <input className="big" value={hours} inputMode="decimal" placeholder="7.5"
                       onChange={(e) => setHours(e.target.value)} onBlur={commitSleep} onKeyDown={onEnter} />
              </label>
              <label className="f" style={{ width: 110 }}>Resting HR
                <input className="big" value={rhr} inputMode="numeric" placeholder="52"
                       onChange={(e) => setRhr(e.target.value)} onBlur={commitSleep} onKeyDown={onEnter} />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="f" style={{ width: 110 }}>Body battery
                <input value={bb} inputMode="numeric" placeholder="on waking, 78"
                       onChange={(e) => setBb(e.target.value)} onBlur={commitSleep} onKeyDown={onEnter} />
              </label>
              <label className="f" style={{ width: 110 }}>Bedtime
                <input value={bed} placeholder="11:15pm"
                       onChange={(e) => setBed(e.target.value)} onBlur={commitSleep} onKeyDown={onEnter} />
              </label>
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              {sleepDone
                ? <span className="saved">Saved: {sleepRec.score ?? "—"} score, {minsToHM(sleepRec.asleepMin)}{sleepRec.restingHr ? `, RHR ${sleepRec.restingHr}` : ""}{sleepRec.bodyBattery != null ? `, battery ${sleepRec.bodyBattery}` : ""}{sleepRec.bedtime ? `, bed ${fmtBedtime(bedtimeMins(sleepRec.bedtime))}` : ""}</span>
                : "Type the numbers and tab out. Hours can be 7.5 or 7:30; bedtime can be 11:15pm or 23:15."}
            </p>
          </div>
        </div>

        {/* ---------------- Workout ---------------- */}
        <div className="panel">
          <h2>Workout <span className="hint">add more than one for a double day</span></h2>
          <div className="body">
            <div className="seg" style={{ marginBottom: 10 }}>
              <button className="run" aria-pressed={wKind === "run"} onClick={() => pickKind("run")}>Run</button>
              <button className="lift" aria-pressed={wKind === "lift"} onClick={() => pickKind("lift")}>Lift</button>
              <button className="rest" aria-pressed={wKind === "rest"} onClick={() => pickKind("rest")}>Rest</button>
            </div>
            {wKind !== "rest" && (
              <div className="chips" style={{ marginBottom: 10 }}>
                {(wKind === "run" ? RUN_TYPES : LIFT_TYPES).map((t) => (
                  <button key={t} className="tchip" aria-pressed={wType === t} onClick={() => setWType(t)}
                          style={{ color: wKind === "run" ? "var(--run)" : "var(--lift)" }}>{t}</button>
                ))}
              </div>
            )}
            <div className="row">
              {wKind === "run" && (
                <>
                  <label className="f" style={{ width: 84 }}>{settings.distanceUnit}
                    <input value={wDist} inputMode="decimal" placeholder="6.2" onChange={(e) => setWDist(e.target.value)} />
                  </label>
                  <label className="f" style={{ width: 96 }}>Pace /{settings.distanceUnit}
                    <input value={wPace} placeholder="8:30" onChange={(e) => setWPace(e.target.value)} />
                  </label>
                </>
              )}
              <label className="f" style={{ flex: 1, minWidth: 140 }}>Note
                <input value={wNote} onChange={(e) => setWNote(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addWorkout()}
                       placeholder={wKind === "run" ? "felt heavy, hot out" : wKind === "lift" ? "bench 3×5 @ 185" : "travel day"} />
              </label>
              <button className="solid" onClick={addWorkout}>Add {wKind}</button>
            </div>
            {daySessions.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                {daySessions.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                    <span className={`tag ${s.kind}`}>{s.kind === "rest" ? "rest" : s.type}</span>
                    <span style={{ flex: 1 }}>
                      {s.name}
                      {s.distanceKm ? ` · ${round(toUnit(s.distanceKm, settings.distanceUnit), 1)} ${settings.distanceUnit}` : ""}
                      {paceSecOf(s, settings.distanceUnit) ? ` · ${secsToClock(paceSecOf(s, settings.distanceUnit))}/${settings.distanceUnit}` : ""}
                      {s.sets ? ` · ${s.sets} sets` : ""}
                      {s.note ? <span style={{ color: "var(--soft)" }}> — {s.note}</span> : ""}
                    </span>
                    {s.source !== "strong" && <button className="del" onClick={() => removeSession(s.id)} title="Remove">×</button>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      <VoiceLog dayKey={dayKey} settings={settings} onApply={applyVoice} />

      {/* ---------------- Day ---------------- */}
      <div className="panel">
        <h2>The day <span className="hint">what kind of day it was</span></h2>
        <div className="body">
          <div className="chips" style={{ marginBottom: 10 }}>
            {settings.dayTags.map((t) => (
              <button key={t} className="tchip" aria-pressed={tags.includes(t)} onClick={() => toggleTag(t)} style={{ color: "var(--sleep)" }}>{t}</button>
            ))}
          </div>
          <div className="row">
            <label className="f" style={{ flex: 1, minWidth: 200 }}>What happened
              <input value={note} placeholder="dinner with M, home by 11 · long day at the office · nothing much"
                     onChange={(e) => setNote(e.target.value)} onBlur={commitDay} onKeyDown={onEnter} />
            </label>
            <label className="f" style={{ width: 100 }}>Steps
              <input value={steps} inputMode="numeric" placeholder="9,400"
                     onChange={(e) => setSteps(e.target.value)} onBlur={commitDay} onKeyDown={onEnter} />
            </label>
          </div>
        </div>
      </div>

      {/* ---------------- Intake ---------------- */}
      <div className="panel">
        <h2>Intake
          <span className="hint">
            {Math.round(caf)} mg caffeine · {round(alc, 1) ?? 0} drinks · {thcN} cannabis · {nicN} nicotine
          </span>
        </h2>
        <div className="body">
          <div className="grid2" style={{ gap: 18 }}>
            {KIND_ORDER.map((kind) => {
              const ps = settings.presets.filter((p) => p.kind === kind);
              if (!ps.length) return null;
              return (
                <div key={kind}>
                  <div className="note" style={{ marginBottom: 5, color: KIND_META[kind].color }}>{KIND_META[kind].name}</div>
                  <div className="chips">
                    {ps.map((p) => (
                      <button key={p.id} className={`chip ${kind}`} onClick={() => logPreset(p)} aria-pressed={pending?.id === p.id}>
                        <i className="dot" /><span className="lbl">{p.label}</span>
                        <span className="amt">{p.ask ? "mg?" : p.unit === "mg" ? `${p.amount}mg` : p.amount > 1 ? p.amount : ""}</span>
                      </button>
                    ))}
                  </div>
                  {pending && pending.kind === kind && (
                    <div className="row" style={{ marginTop: 8 }}>
                      <label className="f" style={{ width: 110 }}>{pending.label}, mg
                        <input autoFocus value={pendingAmt} inputMode="decimal" placeholder={String(pending.amount)}
                               onChange={(e) => setPendingAmt(e.target.value)}
                               onKeyDown={(e) => { if (e.key === "Enter") logPending(); if (e.key === "Escape") setPending(null); }} />
                      </label>
                      <button className="solid" onClick={logPending} disabled={!Number(pendingAmt)}>Log</button>
                      <button className="ghost" onClick={() => setPending(null)}>Cancel</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div className="divline" />
          {!open ? <button className="ghost" onClick={() => setOpen(true)}>Log something else</button> : (
            <div>
              <div className="row">
                <label className="f" style={{ width: 118 }}>Type
                  <select value={cKind} onChange={(e) => setCKind(e.target.value)}>
                    {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_META[k].name}</option>)}
                  </select>
                </label>
                <label className="f" style={{ flex: 1, minWidth: 110 }}>What
                  <input value={cLabel} onChange={(e) => setCLabel(e.target.value)} placeholder="Matcha latte" />
                </label>
                <label className="f" style={{ width: 80 }}>Amount
                  <input value={cAmt} inputMode="decimal" onChange={(e) => setCAmt(e.target.value)} />
                </label>
                <label className="f" style={{ width: 100 }}>Unit
                  <select value={cUnit} onChange={(e) => setCUnit(e.target.value)}>
                    <option value="mg">mg</option><option value="drinks">drinks</option>
                    <option value="hits">hits</option><option value="sessions">sessions</option>
                  </select>
                </label>
                <label className="f" style={{ width: 108 }}>Time
                  <input type="time" value={cTime} onChange={(e) => setCTime(e.target.value)} />
                </label>
              </div>
              <div style={{ marginTop: 9, display: "flex", gap: 8 }}>
                <button className="solid" onClick={addCustom}>Add entry</button>
                <button className="ghost" onClick={() => setOpen(false)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ---------------- What's on file ---------------- */}
      <div className="panel">
        <h2>Logged for {dayLabel.toLowerCase()}</h2>
        <div className="body">
          {!dayDoses.length && !daySessions.length && !sleepDone && !dayDone ? (
            <p className="empty">Nothing yet. Fill in the night, pick a workout, say what kind of day it was, tap what you had.</p>
          ) : (
            <table>
              <thead><tr><th style={{ width: 70 }}>Time</th><th>What</th><th className="num">Amount</th><th style={{ width: 24 }} /></tr></thead>
              <tbody>
                {sleepDone && (
                  <tr>
                    <td style={{ color: "var(--soft)" }}>night</td>
                    <td><span style={{ color: "var(--sleep)", marginRight: 6 }}>●</span>Sleep</td>
                    <td className="num">{sleepRec.score ?? "—"} · {minsToHM(sleepRec.asleepMin)}{sleepRec.restingHr ? ` · ${sleepRec.restingHr} bpm` : ""}{sleepRec.bodyBattery != null ? ` · battery ${sleepRec.bodyBattery}` : ""}</td>
                    <td />
                  </tr>
                )}
                {dayDone && (
                  <tr>
                    <td style={{ color: "var(--soft)" }}>day</td>
                    <td>
                      {tags.map((t) => <span key={t} className="tag" style={{ background: "var(--sleep)", marginRight: 4 }}>{t}</span>)}
                      {dayRec?.note ? <span style={{ color: tags.length ? "var(--soft)" : undefined }}>{tags.length ? " — " : ""}{dayRec.note}</span> : ""}
                    </td>
                    <td className="num">{dayRec?.steps != null ? `${Number(dayRec.steps).toLocaleString()} steps` : ""}</td>
                    <td />
                  </tr>
                )}
                {daySessions.map((s) => (
                  <tr key={s.id}>
                    <td style={{ color: "var(--soft)" }}>{s.source === "manual" ? "day" : fmtClock(s.ts)}</td>
                    <td><span style={{ color: `var(--${s.kind})`, marginRight: 6 }}>●</span>{s.name}{s.note ? <span style={{ color: "var(--soft)" }}> — {s.note}</span> : ""}</td>
                    <td className="num">
                      {s.distanceKm ? `${round(toUnit(s.distanceKm, settings.distanceUnit), 2)} ${settings.distanceUnit}` : ""}
                      {paceSecOf(s, settings.distanceUnit) ? ` · ${secsToClock(paceSecOf(s, settings.distanceUnit))}/${settings.distanceUnit}` : ""}
                      {s.sets ? `${s.sets} sets · ${Math.round(s.tonnage).toLocaleString()} ${settings.weightUnit}` : ""}
                    </td>
                    <td>{s.source !== "strong" && <button className="del" onClick={() => removeSession(s.id)} title="Delete">×</button>}</td>
                  </tr>
                ))}
                {dayDoses.map((d) => (
                  <tr key={d.id}>
                    <td style={{ color: "var(--soft)" }}>{fmtClock(d.ts)}</td>
                    <td><span style={{ color: KIND_META[d.kind]?.color, marginRight: 6 }}>●</span>{d.label}</td>
                    <td className="num">{d.amount} {d.unit}</td>
                    <td><button className="del" onClick={() => removeDose(d.id)} title="Delete">×</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

/* ================================================================== */
/* daily rollups shared by the dashboards                             */
/* ================================================================== */

function useDaily({ doses, sleep, sessions, days = [], settings }) {
  return useMemo(() => rollup({ doses, sleep, sessions, days, settings }),
    [doses, sleep, sessions, days, settings.dayStartHour]);
}

function daysSince(doses, kind) {
  const t = doses.filter((d) => d.kind === kind).map((d) => new Date(d.ts).getTime()).sort((a, b) => b - a)[0];
  return t ? Math.floor((Date.now() - t) / 864e5) : null;
}

/* ---- the three indices --------------------------------------------- */







/* ---- global range + buckets ---------------------------------------- */

const RANGES = [[7, "7d"], [30, "30d"], [90, "90d"], [180, "180d"], [365, "365d"]];

// days when short, weeks in the middle, months when long
function bucketize(dayKeys, range) {
  if (range <= 31) return dayKeys.map((k) => ({ key: k, label: fmtShort(k), days: [k] }));
  const m = new Map();
  if (range <= 400) {
    for (const k of dayKeys) { const w = mondayOf(k); if (!m.has(w)) m.set(w, []); m.get(w).push(k); }
    return [...m.entries()].map(([w, ds]) => ({ key: w, label: fmtShort(w), days: ds }));
  }
  for (const k of dayKeys) { const mo = k.slice(0, 7); if (!m.has(mo)) m.set(mo, []); m.get(mo).push(k); }
  return [...m.entries()].map(([mo, ds]) => ({
    key: mo, days: ds,
    label: fromDayKey(`${mo}-01`).toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
  }));
}
const bucketNoun = (range) => (range <= 31 ? "day" : range <= 400 ? "week" : "month");
const bucketAvg = (b, f) => { const v = b.days.map(f).filter((x) => x != null); return v.length ? avg(v) : null; };
const bucketSum = (b, f) => sum(b.days.map((k) => f(k) || 0));
const tickGap = (n) => Math.max(0, Math.ceil(n / 9) - 1);

function RangeBar({ value, onChange }) {
  return (
    <div className="rangebar">
      <span className="seg">
        {RANGES.map(([d, name]) => (
          <button key={d} aria-pressed={value === d} onClick={() => onChange(d)}>{name}</button>
        ))}
      </span>
    </div>
  );
}

/* ================================================================== */
/* Overview                                                           */
/* ================================================================== */

function Overview({ doses, sleep, sessions, days, settings, range, goLog }) {
  const daily = useDaily({ doses, sleep, sessions, days, settings });
  const today = toDayKey(new Date());
  const d7 = lastNDays(7, today), d30 = lastNDays(30, today), d14 = lastNDays(14, today);
  const span = lastNDays(range, today);
  const u = settings.distanceUnit;

  const sl = (keys) => keys.map((k) => daily.get(k).sleep).filter(Boolean);
  const scoreAvg7 = avg(sl(d7).map((s) => s.score).filter((x) => x != null));
  const scoreAvg30 = avg(sl(d30).map((s) => s.score).filter((x) => x != null));
  const hrsAvg7 = avg(sl(d7).map((s) => s.asleepMin).filter((x) => x != null));
  const hrsAvg30 = avg(sl(d30).map((s) => s.asleepMin).filter((x) => x != null));
  const rhr7 = avg(sl(d7).map((s) => s.restingHr).filter((x) => x != null));
  const rhr30 = avg(sl(d30).map((s) => s.restingHr).filter((x) => x != null));
  const bb7 = avg(sl(d7).map((s) => s.bodyBattery).filter((x) => x != null));
  const bb30 = avg(sl(d30).map((s) => s.bodyBattery).filter((x) => x != null));
  const bed7 = avg(sl(d7).map((s) => bedtimeMins(s.bedtime)).filter((x) => x != null));
  const steps7 = avg(d7.map((k) => daily.get(k).steps).filter((x) => x != null));
  const steps30 = avg(d30.map((k) => daily.get(k).steps).filter((x) => x != null));

  const thisWeek = lastNDays(7, today).filter((k) => k >= mondayOf(today));
  const wkKm = sum(thisWeek.map((k) => daily.get(k).runKm));
  const wkRuns = thisWeek.filter((k) => daily.get(k).hasRun).length;
  const wkLifts = thisWeek.filter((k) => daily.get(k).hasLift).length;
  const wkDrinks = sum(thisWeek.map((k) => daily.get(k).alc));
  const cafAvg7 = avg(d7.map((k) => daily.get(k).caf));
  const cafAvg30 = avg(d30.map((k) => daily.get(k).caf));
  const active30 = d30.filter((k) => daily.get(k).hasRun || daily.get(k).hasLift).length;
  const logged30 = d30.filter((k) => { const x = daily.get(k); return x.sleep || x.sessions.length || x.entries.length; }).length;

  let streak = 0;
  for (let i = 0; i < 60; i++) {
    const x = daily.get(addDays(today, -i));
    if (x.hasRun || x.hasLift) streak++;
    else if (i === 0) continue;
    else break;
  }

  // sleep score against training load, at the range's grain
  const buckets = bucketize(span, range);
  const trend = buckets.map((b) => ({
    label: b.label,
    score: round(bucketAvg(b, (k) => daily.get(k).sleep?.score ?? null), 0),
    run: round(toUnit(bucketSum(b, (k) => daily.get(k).runKm), u), 1),
  }));

  const gap = (a, b) => (a != null && b != null ? `${a >= b ? "+" : ""}${round(a - b, 1)} vs 30d` : "30d avg —");

  return (
    <>
      <ScoreTrio daily={daily} settings={settings} range={range} />

      <AskPanel />

      <div className="panel">
        <h2>Last 7 days <span className="hint">{logged30} of the last 30 days have something logged</span></h2>
        <div className="body">
          <div className="grid4" style={{ gap: 12 }}>
            <Stat v={scoreAvg7 != null ? Math.round(scoreAvg7) : null} l="avg sleep score" color={HEX.sleep}
                  sub={gap(round(scoreAvg7, 0), round(scoreAvg30, 0))}
                  bar={scoreAvg7 != null ? { pct: (scoreAvg7 / settings.sleepScoreGoal) * 100, color: HEX.sleep } : null} />
            <Stat v={hrsAvg7 != null ? minsToHM(hrsAvg7) : null} l="avg asleep" color={HEX.sleep}
                  sub={hrsAvg30 != null ? `${minsToHM(hrsAvg30)} over 30d` : "30d avg —"}
                  bar={hrsAvg7 != null ? { pct: (hrsAvg7 / 60 / settings.sleepHoursGoal) * 100, color: HEX.hours } : null} />
            <Stat v={bb7 != null ? Math.round(bb7) : null} l="avg body battery on waking" color={HEX.hours}
                  sub={gap(round(bb7, 0), round(bb30, 0))}
                  bar={bb7 != null ? { pct: bb7, color: HEX.hours } : null} />
            <Stat v={rhr7 != null ? Math.round(rhr7) : null} l="avg resting HR" color={HEX.rhr}
                  sub={bed7 != null ? `bed around ${fmtBedtime(bed7)}` : rhr30 != null ? `${Math.round(rhr30)} over 30d` : "30d avg —"} />
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>This week <span className="hint">since Monday</span></h2>
          <div className="body">
            <div className="grid2" style={{ gap: 12 }}>
              <Stat v={round(toUnit(wkKm, u), 1) ?? 0} l={`${u} run of ${settings.weeklyDistanceTarget}`} color={HEX.run}
                    bar={{ pct: (toUnit(wkKm, u) / settings.weeklyDistanceTarget) * 100, color: HEX.run }} />
              <Stat v={`${wkRuns + wkLifts}`} l="sessions" color={HEX.lift}
                    sub={`${wkRuns} run${wkRuns === 1 ? "" : "s"}, ${wkLifts} lift${wkLifts === 1 ? "" : "s"} · ${streak} day streak`} />
              <Stat v={steps7 != null ? Math.round(steps7 / 100) / 10 + "k" : null} l="steps / day, 7d avg" color={HEX.lift}
                    sub={steps30 != null ? `${Math.round(steps30 / 100) / 10}k over 30d` : "log steps on the Log tab"}
                    bar={steps7 != null ? { pct: (steps7 / settings.stepsGoal) * 100, color: HEX.lift } : null} />
              <Stat v={active30} l="active days of the last 30" color={HEX.lift} />
            </div>
          </div>
        </div>
        <div className="panel">
          <h2>Intake <span className="hint">7-day average and this week</span></h2>
          <div className="body">
            <div className="grid2" style={{ gap: 12 }}>
              <Stat v={Math.round(cafAvg7 ?? 0)} l="mg caffeine / day" color={kindHex("caffeine")}
                    sub={cafAvg30 != null ? `${Math.round(cafAvg30)} over 30d` : ""}
                    bar={{ pct: ((cafAvg7 ?? 0) / settings.caffeineLimitMg) * 100, color: (cafAvg7 ?? 0) > settings.caffeineLimitMg ? HEX.alert : kindHex("caffeine") }} />
              <Stat v={round(wkDrinks, 1) ?? 0} l={`drinks of ${settings.drinksWeeklyLimit}`} color={kindHex("alcohol")}
                    sub={[["alcohol", "drink"], ["cannabis", "cannabis"], ["nicotine", "nicotine"], ["stimulant", "adderall"]]
                      .map(([k, n]) => { const d = daysSince(doses, k); return d != null ? `${d}d since ${n}` : null; })
                      .filter(Boolean).join(" · ")}
                    bar={{ pct: (wkDrinks / settings.drinksWeeklyLimit) * 100, color: wkDrinks > settings.drinksWeeklyLimit ? HEX.alert : kindHex("alcohol") }} />
            </div>
          </div>
        </div>
      </div>

      <FortnightStrip days={d14} daily={daily} settings={settings} onPick={goLog} />

      <RunVsState daily={daily} sessions={sessions} settings={settings} range={range} />

      <ScoreRidges which="degen" daily={daily} settings={settings} range={range} />

      <div className="panel">
        <h2>Sleep against training load <span className="hint">per {bucketNoun(range)}</span></h2>
        <div className="body" style={{ paddingTop: 8 }}>
          <Chart h={210}>
            <ComposedChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={HEX.grid} vertical={false} />
              <XAxis dataKey="label" tick={axisTick()} interval={tickGap(trend.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
              <YAxis yAxisId="score" domain={[40, 100]} tick={axisTick()} tickLine={false} axisLine={false} />
              <YAxis yAxisId="run" orientation="right" tick={axisTick()} tickLine={false} axisLine={false} />
              <Tooltip content={<Tip fmt={(p) => p.dataKey === "run" ? `${p.value} ${u}` : p.value} />} />
              <Bar yAxisId="run" dataKey="run" name="Run" fill={HEX.run} opacity={0.75} radius={[2, 2, 0, 0]} />
              <Line yAxisId="score" type="monotone" dataKey="score" name="Sleep score" stroke={HEX.sleep} strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
            </ComposedChart>
          </Chart>
          <div className="legend">
            <span><i style={{ background: HEX.sleep }} />sleep score (left)</span>
            <span><i style={{ background: HEX.run }} />{u} run (right)</span>
          </div>
        </div>
      </div>

      <Ledger days={lastNDays(Math.min(range, 60), today)} daily={daily} settings={settings} onPick={goLog} />
    </>
  );
}

/* ---- the scores, shared by every tab ------------------------------- */

const SCORES = {
  regen: { name: "Regen", color: HEX.sleep, good: true, tag: "sleep", blurb: "higher means better sleep" },
  run:   { name: "Stamina", color: HEX.run, good: true, tag: "running", blurb: "your aerobic fitness, as a weekly distance equivalent" },
  degen: { name: "Degen", color: HEX.alert, good: false, tag: "intake", blurb: "higher means more intake; big nights count extra" },
};
const SCORE_KEYS = ["regen", "run", "degen"];
/* Only Degen is worth measuring against your own spread: it is spiky and unbounded, so
   "heavier than usual" is the useful reading. Regen lives in a tight band and Stamina
   moves slowly by design — indexing those exaggerates noise and pegs at 100. They are
   better read absolutely, on a scale that means the same thing next year. */
const INDEXED = { regen: false, run: false, degen: true };
// line style carries the series as well as colour, so the chart survives without colour
const SCORE_DASH = { regen: "0", run: "7 4", degen: "2 3" };
const scoreWord = (v, good) => (v == null ? "no data yet" : good
  ? v >= 80 ? "strong" : v >= 65 ? "solid" : v >= 50 ? "middling" : "low"
  : v >= 60 ? "heavy" : v >= 35 ? "elevated" : v >= 15 ? "moderate" : "light");

function useScores(daily, settings, range) {
  const today = toDayKey(new Date());
  return useMemo(() => {
    const span = lastNDays(range, today);
    const rows = buildIndices(daily, span, settings);
    const now = rows[rows.length - 1];                       // built from yesterday back four days
    const byDate = new Map(rows.map((r) => [r.date, r]));

    // Place each score against its own spread over the window: the window's lowest day
    // is 0, its median 50, its highest 100. A week is too short for that to say anything,
    // so 7d keeps the raw number.
    // the same window again, immediately before this one, so real change is visible
    const prevSpan = lastNDays(range, addDays(span[0], -1));
    const prevRows = buildIndices(daily, prevSpan, settings);

    const indexed = range >= 30;
    const rel = {}, band = {}, delta = {};
    for (const k of SCORE_KEYS) {
      const vals = rows.map((r) => r[k]).filter((v) => v != null);
      const prevVals = prevRows.map((r) => r[k]).filter((v) => v != null);
      delta[k] = vals.length >= 3 && prevVals.length >= 3
        ? round(median(vals) - median(prevVals), 1) : null;
      const sorted = [...vals].sort((a, b) => a - b);
      band[k] = vals.length >= 3
        ? { median: round(median(vals), 1), lo: round(quantile(sorted, 0.05), 1), hi: round(quantile(sorted, 0.95), 1), n: vals.length }
        : null;
      rel[k] = indexed && INDEXED[k] ? round(relToMedian(now?.[k], vals), 0) : null;
    }

    const chart = bucketize(span, range).map((b) => ({
      label: b.label,
      regen: round(bucketAvg(b, (k) => byDate.get(k)?.regen ?? null), 1),
      run: round(bucketAvg(b, (k) => byDate.get(k)?.run ?? null), 1),
      degen: round(bucketAvg(b, (k) => byDate.get(k)?.degen ?? null), 1),
    }));
    return { now, rel, band, delta, chart, indexed };
  }, [daily, settings, range, today]);
}

/* The headline number: placed against the window when there is enough of it, raw otherwise. */
function ScoreStat({ which, now, rel, band, delta, indexed, unit }) {
  const m = SCORES[which];
  const raw = now?.[which];
  const useIndex = indexed && INDEXED[which] && rel[which] != null;
  const v = useIndex ? rel[which] : raw;
  const b = band[which];
  const d = delta?.[which];
  const move = d == null || Math.abs(d) < 0.5 ? null : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)} on the period before`;

  // Stamina reads in the unit it is actually made of
  const weekly = which === "run" && now?.staminaWeekly != null ? now.staminaWeekly : null;
  const sub = raw == null ? "nothing logged yet"
    : useIndex ? `${Math.round(raw)} raw · median ${b?.median}${move ? ` · ${move}` : ""}`
    : weekly != null ? `about ${weekly} ${unit || "mi"}/week of fitness${move ? ` · ${move}` : ""}`
    : `${m.tag} has been ${scoreWord(raw, m.good)}${move ? ` · ${move}` : ""}`;
  const label = useIndex ? `${m.name}, vs window` : which === "run" ? `${m.name}, 0–100 fixed` : m.name;
  return (
    <Stat v={v != null ? Math.round(v) : null} l={label} color={m.color} sub={sub}
          bar={v != null ? { pct: v, color: m.color } : null} />
  );
}

function ScoreLines({ chart, keys, band, range, h = 220 }) {
  return (
    <Chart h={h}>
      <LineChart data={chart} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
        <CartesianGrid stroke={HEX.grid} vertical={false} />
        <XAxis dataKey="label" tick={axisTick()} interval={tickGap(chart.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
        <YAxis domain={[0, 100]} tick={axisTick()} tickLine={false} axisLine={false} />
        <Tooltip content={<Tip />} />
        {keys.map((k) => (band?.[k] ? (
          <ReferenceLine key={`med-${k}`} y={band[k].median} stroke={SCORES[k].color} strokeDasharray="3 4" opacity={0.5} />
        ) : null))}
        {keys.map((k) => (
          <Line key={k} type="monotone" dataKey={k} name={SCORES[k].name} stroke={SCORES[k].color} strokeWidth={2.4}
                strokeDasharray={SCORE_DASH[k]} dot={range <= 31 && keys.length === 1 ? { r: 2.5 } : false} connectNulls />
        ))}
      </LineChart>
    </Chart>
  );
}

/* Ask a question of your own log. */
function AskPanel() {
  const [q, setQ] = useState("");
  const [a, setA] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const ask = async (text) => {
    const question = (text ?? q).trim();
    if (!question) return;
    setBusy(true); setErr(""); setA(null); setQ(question);
    try { const j = await callFn("/.netlify/functions/ask", { method: "POST", body: { question } }); setA(j.answer); }
    catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const examples = ["What happens to my sleep after a heavy night?", "Which weekday is my worst?", "Am I running more or less than last month?"];

  return (
    <div className="panel">
      <h2>Ask <span className="hint">answered only from your own numbers</span></h2>
      <div className="body">
        <div className="row">
          <label className="f" style={{ flex: 1, minWidth: 200 }}>
            <input value={q} placeholder="Why was last week worse than usual?"
                   onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ask()} />
          </label>
          <button className="solid" onClick={() => ask()} disabled={busy || !q.trim()}>{busy ? "Thinking…" : "Ask"}</button>
        </div>
        {!a && !err && !busy && (
          <div className="chips" style={{ marginTop: 10 }}>
            {examples.map((x) => <button key={x} className="tchip" onClick={() => ask(x)}>{x}</button>)}
          </div>
        )}
        {err && <p className="note flag" style={{ marginTop: 10 }}>{err}</p>}
        {a && <p className="note" style={{ marginTop: 12, color: "var(--ink)", fontSize: 13.5, lineHeight: 1.6 }}>{a}</p>}
        {a && <p className="note" style={{ marginTop: 8, color: "var(--faint)" }}>Written by a model from figures this app computed. It can misread them — check anything surprising against the charts.</p>}
      </div>
    </div>
  );
}

/* Overview opener: the three scores on one chart */
function ScoreTrio({ daily, settings, range }) {
  const sc = useScores(daily, settings, range);
  return (
    <div className="panel">
      <h2>Regen, Stamina and Degen
        <span className="hint">Regen and Stamina are absolute; Degen is placed against your own last {range} days</span>
      </h2>
      <div className="body">
        <div className="grid3" style={{ gap: 12, marginBottom: 12 }}>
          {SCORE_KEYS.map((k) => <ScoreStat key={k} which={k} unit={settings.distanceUnit} {...sc} />)}
        </div>
        <ScoreLines chart={sc.chart} keys={SCORE_KEYS} band={sc.band} range={range} h={240} />
        <div className="legend">
          {SCORE_KEYS.map((k) => (
            <span key={k}>
              <svg width="26" height="9" style={{ marginRight: 5, verticalAlign: "-1px" }} aria-hidden="true">
                <line x1="0" y1="4.5" x2="26" y2="4.5" stroke={SCORES[k].color} strokeWidth="2.4" strokeDasharray={SCORE_DASH[k]} />
              </svg>
              {SCORES[k].name}: {SCORES[k].blurb}
            </span>
          ))}
          <span>faint horizontal lines mark each median</span>
        </div>
      </div>
    </div>
  );
}

/* One score, at the top of its own tab */
function ScorePanel({ which, daily, settings, range }) {
  const sc = useScores(daily, settings, range);
  const m = SCORES[which];
  const raw = sc.now?.[which], r = sc.rel[which], b = sc.band[which];
  return (
    <div className="panel">
      <h2>{m.name} Score
        <span className="hint">{m.blurb} · yesterday{INDEXED[which] && sc.indexed ? `, against your last ${range} days` : which === "run" ? ", on a fixed 0–100 scale where 100 is 70 a week" : ""}</span>
      </h2>
      <div className="body">
        <div className="scorerow">
          <div>
            <ScoreStat which={which} unit={settings.distanceUnit} {...sc} />
            {which === "run" && sc.now?.staminaWeekly != null && (
              <p className="note" style={{ marginTop: 8 }}>
                Your engine is worth about <b>{sc.now.staminaWeekly} {settings?.distanceUnit || "mi"} a week</b> right now —
                a weighted average of the last four weeks of running, with the recent days counting most.
              </p>
            )}
            {which === "run" && sc.now?.freshness != null && (
              <div style={{ marginTop: 10 }}>
                <Stat v={`${sc.now.freshness > 0 ? "+" : ""}${Math.round(sc.now.freshness)}%`} l="Freshness"
                      color={sc.now.freshness >= 5 ? HEX.run : sc.now.freshness <= -12 ? HEX.alert : HEX.rest}
                      sub={sc.now.freshness >= 15 ? "well rested, or detrained"
                        : sc.now.freshness >= 5 ? "rested"
                        : sc.now.freshness > -12 ? "normal training fatigue"
                        : "carrying real fatigue"} />
              </div>
            )}
            {INDEXED[which] && sc.indexed && raw != null && b && (
              <p className="note" style={{ marginTop: 8 }}>
                {r == null ? "Not enough days in this window to place it."
                  : r >= 50
                    ? `${Math.round(r) - 50} of the 50 points from your median up to a top-5% day in this window.`
                    : `${50 - Math.round(r)} of the 50 points from your median down to a bottom-5% day in this window.`}
              </p>
            )}
          </div>
          <ScoreLines chart={sc.chart} keys={[which]} band={sc.band} range={range} h={160} />
        </div>
      </div>
    </div>
  );
}

/* How runs land depending on the state you were in.
   Position is the context you ran in, the dot is the run itself. */
function RunVsState({ daily, sessions, settings, range }) {
  const today = toDayKey(new Date());
  const [lag, setLag] = useState(1);
  const u = settings.distanceUnit;

  const { pts, buckets, r, yMode, skipped } = useMemo(() => {
    const span = lastNDays(range, today);
    const raw = buildIndices(daily, span, settings);
    // Both axes use the same window-relative scale as the score cards, so 50 is your
    // median on each and the dots use the whole square instead of hugging one edge.
    const regVals = raw.map((x) => x.regen).filter((v) => v != null);
    const degVals = raw.map((x) => x.degen).filter((v) => v != null);
    const idx = new Map(raw.map((x) => [x.date, {
      regen: relToMedian(x.regen, regVals), degen: relToMedian(x.degen, degVals),
      regenRaw: x.regen, degenRaw: x.degen,
    }]));

    // pace is judged inside its own run type, so a long run isn't punished for being slow
    const byType = new Map();
    for (const s of sessions) {
      if (s.kind !== "run") continue;
      const p = paceSecOf(s, "km"); if (!p) continue;
      if (!byType.has(s.type)) byType.set(s.type, []);
      byType.get(s.type).push(p);
    }
    const medByType = new Map([...byType].map(([t, v]) => [t, median(v)]));

    const out = [];
    const skip = { noDist: 0, noState: 0, noPace: 0 };
    for (const s of sessions) {
      if (s.kind !== "run") continue;
      if (!s.distanceKm) { skip.noDist++; continue; }
      const state = idx.get(addDays(s.date, -(lag - 1)));      // lag 1 = the morning of the run
      // Regen needs sleep entries, which may not reach as far back as the runs do, so it is optional
      if (!state || state.degen == null) { skip.noState++; continue; }
      if (!paceSecOf(s, "km")) skip.noPace++;
      const p = paceSecOf(s, "km");
      const med = medByType.get(s.type);
      const rel = p && med ? (med - p) / med : null;            // + = faster than usual for the type
      out.push({
        degen: state.degen, regen: state.regen ?? null,
        degenRaw: state.degenRaw, regenRaw: state.regenRaw,
        dist: round(toUnit(s.distanceKm, u), 1), z: round(toUnit(s.distanceKm, u), 1),
        rel, date: s.date, type: s.type,
        pace: p ? secsToClock(u === "mi" ? p * KM_PER_MI : p) : null,
      });
    }

    const B = [["light", 0, 33], ["moderate", 33, 60], ["heavy", 60, 101]];
    const bk = B.map(([name, lo, hi]) => {
      const g = out.filter((o) => o.degen >= lo && o.degen < hi);
      const paced = g.filter((o) => o.rel != null);
      return {
        name, n: g.length,
        dist: g.length ? round(avg(g.map((o) => o.dist)), 1) : null,
        rel: paced.length ? round(avg(paced.map((o) => o.rel)) * 100, 1) : null,
      };
    });
    const withPace = out.filter((o) => o.rel != null);
    // Until there is real sleep history the vertical axis shows distance instead of Regen
    const mode = out.filter((o) => o.regen != null).length >= 8 ? "regen" : "dist";
    return {
      pts: mode === "regen" ? out.filter((o) => o.regen != null) : out,
      buckets: bk, yMode: mode, skipped: skip,
      r: pearson(withPace.map((o) => o.degen), withPace.map((o) => o.rel)),
    };
  }, [daily, sessions, settings, range, lag, u, today]);

  // colour and shape both carry the pace: up-triangle faster, square typical, down-triangle slower
  const paceBand = (rel) => (rel == null || Math.abs(rel) <= 0.02 ? "same" : rel > 0 ? "fast" : "slow");
  const BAND = { fast: HEX.run, same: HEX.rest, slow: HEX.alert };
  const dotColor = (rel) => BAND[paceBand(rel)];
  const dotShape = (props) => {
    const { cx, cy, payload, fill } = props;
    const r = Math.max(4, Math.sqrt(Math.max(0, payload.z)) * 2.2);
    const b = paceBand(payload.rel);
    const common = { fill, fillOpacity: 0.55, stroke: fill, strokeWidth: 1.6 };
    if (b === "fast") return <polygon points={`${cx},${cy - r} ${cx + r},${cy + r * 0.75} ${cx - r},${cy + r * 0.75}`} {...common} />;
    if (b === "slow") return <polygon points={`${cx},${cy + r} ${cx + r},${cy - r * 0.75} ${cx - r},${cy - r * 0.75}`} {...common} />;
    return <rect x={cx - r * 0.8} y={cy - r * 0.8} width={r * 1.6} height={r * 1.6} {...common} />;
  };
  const rWord = r == null ? "not enough runs with pace yet"
    : Math.abs(r) < 0.2 ? "no clear link" : r < 0 ? "heavier days do track with slower running" : "heavier days track with faster running, which is worth a second look";

  return (
    <div className="panel">
      <h2>{yMode === "regen" ? "Runs against the state you were in" : "Runs against how heavy the days were"}
        <span className="seg" style={{ fontSize: 12 }}>
          {[[1, "same morning"], [2, "next day"], [3, "two days later"]].map(([v, name]) => (
            <button key={v} aria-pressed={lag === v} onClick={() => setLag(v)} style={{ padding: "3px 9px", fontSize: 12 }}>{name}</button>
          ))}
        </span>
      </h2>
      <div className="body" style={{ paddingTop: 8 }}>
        {pts.length < 3 ? (
          <p className="empty">
            Not enough to plot in this range yet.
            {skipped.noState > 0 && ` ${skipped.noState} run${skipped.noState === 1 ? "" : "s"} fall on days with no intake logged, so there is no Degen score to place them against.`}
            {skipped.noDist > 0 && ` ${skipped.noDist} have no distance.`}
            {" "}Widen the range, or fill in intake on the Log tab for the days you ran.
          </p>
        ) : (
          <>
            <Chart h={300}>
              <ScatterChart margin={{ top: 10, right: 12, left: -12, bottom: 4 }}>
                <CartesianGrid stroke={HEX.grid} />
                <XAxis type="number" dataKey="degen" name="Degen" domain={[0, 100]} tick={axisTick()}
                       tickLine={false} axisLine={{ stroke: HEX.rule }}
                       label={{ value: "Degen, vs your median →", position: "insideBottomRight", offset: -2, fill: HEX.axis, fontSize: 11 }} />
                {yMode === "regen" ? (
                  <YAxis type="number" dataKey="regen" name="Regen" domain={[0, 100]} tick={axisTick()}
                         tickLine={false} axisLine={false}
                         label={{ value: "Regen, vs your median →", angle: -90, position: "insideLeft", offset: 18, fill: HEX.axis, fontSize: 11 }} />
                ) : (
                  <YAxis type="number" dataKey="dist" name="Distance" tick={axisTick()}
                         tickLine={false} axisLine={false}
                         label={{ value: `${u} →`, angle: -90, position: "insideLeft", offset: 22, fill: HEX.axis, fontSize: 11 }} />
                )}
                <ZAxis type="number" dataKey="z" range={[40, 420]} />
                <ReferenceLine x={50} stroke={HEX.rule} />
                {yMode === "regen" && <ReferenceLine y={50} stroke={HEX.rule} />}
                <Tooltip content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload;
                  return (
                    <div className="rc-tip">
                      <b>{fmtDayLabel(d.date)}</b>
                      <div>{d.dist} {u} {d.type}{d.pace ? ` at ${d.pace}/${u}` : ""}</div>
                      <div>
                        Degen {Math.round(d.degen)}{d.regen != null ? ` · Regen ${Math.round(d.regen)}` : ""}
                        <span style={{ color: "var(--faint)" }}> (raw {Math.round(d.degenRaw)}{d.regenRaw != null ? ` / ${Math.round(d.regenRaw)}` : ""})</span>
                      </div>
                      {d.rel != null && <div>{d.rel >= 0 ? "faster" : "slower"} than your usual {d.type} pace by {Math.abs(round(d.rel * 100, 1))}%</div>}
                    </div>
                  );
                }} />
                <Scatter data={pts} shape={dotShape}>
                  {pts.map((p, i) => <Cell key={i} fill={dotColor(p.rel)} />)}
                </Scatter>
              </ScatterChart>
            </Chart>
            <div className="legend">
              <span>each mark is a run · bigger means further</span>
              <span><i style={{ background: HEX.run, clipPath: "polygon(50% 0, 100% 100%, 0 100%)" }} />▲ faster than usual for that run type</span>
              <span><i style={{ background: HEX.rest }} />■ about usual</span>
              <span><i style={{ background: HEX.alert, clipPath: "polygon(0 0, 100% 0, 50% 100%)" }} />▼ slower</span>
              <span>{yMode === "regen"
                ? "both axes are relative to your own median for the range, so 50 is a typical day"
                : "Degen is relative to your median; the vertical axis stays on distance until eight or more nights of sleep are logged in this range"}</span>
            </div>
            <div className="divline" />
            <table>
              <thead><tr><th>Degen at the time</th><th className="num">Runs</th><th className="num">Avg {u}</th><th className="num">Pace vs usual</th></tr></thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.name}>
                    <td style={{ textTransform: "capitalize" }}>{b.name}</td>
                    <td className="num">{b.n}</td>
                    <td className="num">{b.dist ?? "—"}</td>
                    <td className="num" style={{ color: b.rel == null ? undefined : b.rel > 0 ? HEX.run : HEX.alert }}>
                      {b.rel == null ? "—" : `${b.rel > 0 ? "+" : ""}${b.rel}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note" style={{ marginTop: 10 }}>
              {rWord}{r != null ? ` (r = ${round(r, 2)})` : ""}. Bucketed averages are steadier than the scatter while the history is thin.
              Bear in mind you may choose an easy run after a heavy night, so some of this is your decision rather than your legs.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* Any of the three scores by weekday, drawn as overlapping density curves. */
function ScoreRidges({ which = "degen", daily, settings, range }) {
  const today = toDayKey(new Date());
  const rows = useMemo(() => {
    const span = lastNDays(range, today);
    const idx = buildIndices(daily, span, settings);
    const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const byDow = new Map(DOW.map((d) => [d, []]));
    for (const x of idx) if (x[which] != null) byDow.get(DOW[fromDayKey(x.date).getDay()]).push(x[which]);

    // a gaussian kernel over 0..100, so a handful of days still reads as a curve
    const grid = Array.from({ length: 51 }, (_, i) => i * 2);
    const bw = 9;
    return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => {
      const v = byDow.get(d);
      const dens = grid.map((g) => sum(v.map((x) => Math.exp(-((g - x) ** 2) / (2 * bw * bw)))) / (v.length || 1));
      const peak = Math.max(...dens, 1e-9);
      return { day: d, n: v.length, med: v.length ? round(median(v), 0) : null, dens: dens.map((y) => y / peak) };
    });
  }, [daily, settings, range, today, which]);

  const W = 720, rowH = 42, padL = 46, padR = 62, padT = 50;
  const H = padT + rows.length * rowH + 24;
  const iw = W - padL - padR;
  const x = (i) => padL + (i / 50) * iw;
  const anyData = rows.some((r) => r.n > 0);

  return (
    <div className="panel">
      <h2>{SCORES[which].name} by day of the week <span className="hint">where each weekday tends to land</span></h2>
      <div className="body" style={{ paddingTop: 10 }}>
        {!anyData ? <p className="empty">Nothing to draw yet.</p> : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Degen distribution by weekday">
              {[0, 25, 50, 75, 100].map((g) => (
                <g key={g}>
                  <line x1={x(g / 2)} x2={x(g / 2)} y1={10} y2={padT + (rows.length - 1) * rowH + 6} stroke={HEX.grid} />
                  <text x={x(g / 2)} y={H - 6} fontSize="10" fill={HEX.axis} textAnchor="middle">{g}</text>
                </g>
              ))}
              {rows.map((r, ri) => {
                const base = padT + ri * rowH;
                const amp = rowH * 1.05;
                const path = r.dens.map((y, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${(base - y * amp).toFixed(1)}`).join(" ");
                const weekend = r.day === "Fri" || r.day === "Sat";
                return (
                  <g key={r.day}>
                    <line x1={padL} x2={padL + iw} y1={base} y2={base} stroke={HEX.grid} />
                    {r.n > 0 && (
                      <>
                        <path d={`${path} L${x(50)},${base} L${padL},${base} Z`} fill={weekend ? HEX.alert : SCORES[which].color} opacity={weekend ? 0.28 : 0.16} />
                        <path d={path} fill="none" stroke={weekend ? HEX.alert : SCORES[which].color} strokeWidth="2"
                              strokeDasharray={weekend ? "6 3" : "0"} />
                        {r.med != null && <circle cx={x(r.med / 2)} cy={base} r="2.8" fill={weekend ? HEX.alert : SCORES[which].color} />}
                      </>
                    )}
                    <text x={padL - 8} y={base - 2} fontSize="11" fill={HEX.soft} textAnchor="end">{r.day}</text>
                    <text x={padL + iw + 8} y={base - 2} fontSize="10.5" fill={HEX.axis}>
                      {r.n ? `${r.med} · ${r.n}d` : "—"}
                    </text>
                  </g>
                );
              })}
            </svg>
            <div className="legend">
              <span>curves show where that weekday's {SCORES[which].name} scores pile up; the dot marks its median</span>
              <span><i style={{ background: HEX.alert, opacity: 0.6 }} />Fri and Sat, drawn with a dashed outline</span>
              <span>right-hand figures are median and days counted</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* the lifestyle ledger: one line per day, newest first */
function Ledger({ days, daily, settings, onPick }) {
  const u = settings.distanceUnit;
  const rows = [...days].reverse().map((k) => daily.get(k))
    .filter((x) => x.sleep || x.sessions.length || x.entries.length || x.tags.length || x.note);
  if (!rows.length) return null;
  return (
    <div className="panel">
      <h2>Ledger <span className="hint">last 30 days, tap a row to edit it</span></h2>
      <div className="body" style={{ overflowX: "auto" }}>
        <table>
          <thead><tr><th>Day</th><th>The day</th><th>Training</th><th className="num">Sleep</th><th className="num">Battery</th><th className="num">Intake</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.date} onClick={() => onPick(x.date)} style={{ cursor: "pointer" }}>
                <td style={{ whiteSpace: "nowrap" }}>{fmtDayLabel(x.date)}</td>
                <td>
                  {x.tags.map((t) => <span key={t} className="tag" style={{ background: "var(--sleep)", marginRight: 4 }}>{t}</span>)}
                  {x.note ? <span style={{ color: "var(--soft)" }}>{x.note}</span> : ""}
                </td>
                <td style={{ whiteSpace: "nowrap" }}>
                  {x.sessions.map((s) => (
                    <span key={s.id} className={`tag ${s.kind}`} style={{ marginRight: 4 }}>
                      {s.kind === "rest" ? "rest" : s.type}{s.distanceKm ? ` ${round(toUnit(s.distanceKm, u), 1)}` : ""}
                    </span>
                  ))}
                  {x.steps != null ? <span style={{ color: "var(--soft)", fontSize: 11.5 }}>{Math.round(x.steps / 100) / 10}k steps</span> : ""}
                </td>
                <td className="num" style={{ whiteSpace: "nowrap" }}>{x.sleep?.score ?? "—"}{x.sleep?.asleepMin ? ` · ${round(x.sleep.asleepMin / 60, 1)}h` : ""}</td>
                <td className="num">{x.sleep?.bodyBattery ?? "—"}</td>
                <td className="num" style={{ whiteSpace: "nowrap", color: "var(--soft)" }}>
                  {[x.caf ? `${Math.round(x.caf)}mg` : null, x.alc ? `${round(x.alc, 1)} drk` : null, x.thc ? `${x.thc} thc` : null, x.nic ? `${x.nic} nic` : null, x.stim ? `${round(x.stim, 1)} stim` : null].filter(Boolean).join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* fourteen-day strip: one column per day, sleep score as a bar, workout tag, intake dots */
function FortnightStrip({ days, daily, settings, onPick }) {
  const W = 960, colW = W / days.length, H = 166;
  const barTop = 20, barH = 62, tagY = 100, dotsY = 122, dayTagY = 140;
  const today = toDayKey(new Date());
  return (
    <div className="panel">
      <h2>Fourteen days <span className="hint">tap a day to open it in the log</span></h2>
      <div className="body" style={{ paddingTop: 6 }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }} role="img" aria-label="Fourteen-day summary">
          <line x1={0} x2={W} y1={barTop + barH} y2={barTop + barH} stroke={HEX.rule} />
          <line x1={0} x2={W} y1={barTop + barH - (settings.sleepScoreGoal / 100) * barH} y2={barTop + barH - (settings.sleepScoreGoal / 100) * barH} stroke={HEX.sleep} strokeDasharray="3 4" opacity={0.5} />
          {days.map((k, i) => {
            const x = daily.get(k); const cx = i * colW + colW / 2;
            const score = x.sleep?.score;
            const h = score != null ? (score / 100) * barH : 0;
            const tag = x.hasRun && x.hasLift ? "both" : x.hasRun ? "run" : x.hasLift ? "lift" : x.isRest ? "rest" : null;
            const dots = x.entries.slice(0, 8);
            const dow = fromDayKey(k).toLocaleDateString(undefined, { weekday: "narrow" });
            return (
              <g key={k} onClick={() => onPick(k)} style={{ cursor: "pointer" }}>
                <rect x={i * colW} y={0} width={colW} height={H} fill={k === today ? HEX.sleep : "transparent"} opacity={0.05} />
                {score != null ? (
                  <>
                    <rect x={cx - 14} y={barTop + barH - h} width={28} height={h} fill={HEX.sleep} opacity={score >= settings.sleepScoreGoal ? 0.9 : 0.5} />
                    <text x={cx} y={barTop + barH - h - 4} fontSize="10.5" fill={HEX.sleep} textAnchor="middle">{score}</text>
                  </>
                ) : (
                  <text x={cx} y={barTop + barH - 4} fontSize="10" fill={HEX.faint} textAnchor="middle">·</text>
                )}
                {tag && (
                  <>
                    <rect x={cx - 20} y={tagY - 10} width={40} height={16} rx={8}
                          fill={tag === "run" ? HEX.run : tag === "lift" ? HEX.lift : tag === "both" ? HEX.lift : "#B9CADC"} />
                    <text x={cx} y={tagY + 2} fontSize="9.5" fill={tag === "rest" ? HEX.ink : HEX.card} textAnchor="middle">{tag}</text>
                  </>
                )}
                {dots.map((d, j) => (
                  <circle key={d.id} cx={cx - ((dots.length - 1) * 4) + j * 8} cy={dotsY} r={3} fill={kindHex(d.kind) || HEX.rest} />
                ))}
                {x.tags.length > 0 && x.tags[0] !== "normal" && (
                  <text x={cx} y={dayTagY} fontSize="9.5" fill={HEX.sleep} textAnchor="middle">{x.tags[0]}{x.tags.length > 1 ? " +" : ""}</text>
                )}
                <text x={cx} y={H - 4} fontSize="10" fill={k === today ? HEX.ink : HEX.faint} textAnchor="middle">
                  {dow} {fromDayKey(k).getDate()}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="legend">
          <span><i style={{ background: HEX.sleep }} />sleep score (dashed line = goal {settings.sleepScoreGoal})</span>
          <span><i style={{ background: HEX.run }} />run</span>
          <span><i style={{ background: HEX.lift }} />lift</span>
          <span><i style={{ background: kindHex("caffeine") }} />caffeine</span>
          <span><i style={{ background: kindHex("alcohol") }} />alcohol</span>
          <span><i style={{ background: kindHex("cannabis") }} />cannabis</span>
          <span><i style={{ background: kindHex("nicotine") }} />nicotine</span>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Sleep                                                              */
/* ================================================================== */

function SleepDash({ doses, sleep, sessions, days: dayRecs, settings, range }) {
  const daily = useDaily({ doses, sleep, sessions, days: dayRecs, settings });
  const today = toDayKey(new Date());
  const span = lastNDays(range, today);

  const rows = span.map((k) => {
    const x = daily.get(k); const prev = daily.get(addDays(k, -1));
    return {
      k, score: x.sleep?.score ?? null,
      hours: x.sleep?.asleepMin != null ? round(x.sleep.asleepMin / 60, 2) : null,
      rhr: x.sleep?.restingHr ?? null, bb: x.sleep?.bodyBattery ?? null, bed: bedtimeMins(x.sleep?.bedtime),
      prevAlc: prev.alc, prevCaf: prev.caf, prevTrained: prev.hasRun || prev.hasLift, prevTags: prev.tags,
    };
  });
  const byK = new Map(rows.map((r) => [r.k, r]));
  const buckets = bucketize(span, range);
  const chart = buckets.map((b) => ({
    label: b.label,
    score: round(bucketAvg(b, (k) => byK.get(k)?.score), 0),
    hours: round(bucketAvg(b, (k) => byK.get(k)?.hours), 1),
    rhr: round(bucketAvg(b, (k) => byK.get(k)?.rhr), 0),
    bb: round(bucketAvg(b, (k) => byK.get(k)?.bb), 0),
    bed: round(bucketAvg(b, (k) => byK.get(k)?.bed), 0),
  }));

  const scored = rows.filter((r) => r.score != null);
  const scores = scored.map((r) => r.score);
  const hoursArr = rows.filter((r) => r.hours != null).map((r) => r.hours);
  const rhrArr = rows.filter((r) => r.rhr != null).map((r) => r.rhr);
  // a week against the rest of the window: a lift of a few beats is the classic sign of
  // accumulated fatigue, a poor night, or something coming on
  const rhrLast7 = rows.slice(-7).map((r) => r.rhr).filter((v) => v != null);
  const rhrBase = rows.slice(0, -7).map((r) => r.rhr).filter((v) => v != null);
  const rhrNow = rhrLast7.length ? avg(rhrLast7) : null;
  const rhrNorm = rhrBase.length >= 5 ? median(rhrBase) : null;
  const rhrDelta = rhrNow != null && rhrNorm != null ? round(rhrNow - rhrNorm, 1) : null;
  const bbArr = rows.filter((r) => r.bb != null).map((r) => r.bb);
  const bedArr = rows.filter((r) => r.bed != null).map((r) => r.bed);

  const weekday = [1, 2, 3, 4, 5, 6, 0].map((dow) => {
    const s = scored.filter((r) => fromDayKey(r.k).getDay() === dow).map((r) => r.score);
    return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow], score: s.length ? round(avg(s), 0) : null, n: s.length };
  });

  const afterDrinks = scored.filter((r) => r.prevAlc > 0).map((r) => r.score);
  const dry = scored.filter((r) => r.prevAlc === 0).map((r) => r.score);
  const afterTrain = scored.filter((r) => r.prevTrained).map((r) => r.score);
  const noTrain = scored.filter((r) => !r.prevTrained).map((r) => r.score);
  const rAlc = pearson(scored.map((r) => r.prevAlc), scores);
  const rCaf = pearson(scored.map((r) => r.prevCaf), scores);
  const withRhr = scored.filter((r) => r.rhr != null);
  const rRhr = pearson(withRhr.map((r) => r.rhr), withRhr.map((r) => r.score));
  const withBed = scored.filter((r) => r.bed != null);
  const rBed = pearson(withBed.map((r) => r.bed), withBed.map((r) => r.score));
  const tagRows = settings.dayTags.map((t) => {
    const after = scored.filter((r) => r.prevTags.includes(t));
    return { tag: t, score: after.length ? Math.round(avg(after.map((r) => r.score))) : null,
      bb: after.filter((r) => r.bb != null).length ? Math.round(avg(after.filter((r) => r.bb != null).map((r) => r.bb))) : null, n: after.length };
  }).filter((r) => r.n);

  const recent = [...sleep].filter((s) => s.score != null || s.asleepMin != null || s.bodyBattery != null).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);
  const rWord = (r) => (r == null ? "not enough nights yet" : Math.abs(r) < 0.2 ? "no real relationship" : Math.abs(r) < 0.5 ? "a weak link" : "a clear link");
  const noun = bucketNoun(range);

  return (
    <>
      <ScorePanel which="regen" daily={daily} settings={settings} range={range} />
      <ScoreRidges which="regen" daily={daily} settings={settings} range={range} />
      <div className="panel">
        <h2>Sleep <span className="hint">last {range} days</span></h2>
        <div className="body">
          <div className="grid4" style={{ gap: 12 }}>
            <Stat v={scores.length ? Math.round(avg(scores)) : null} l="avg score" color={HEX.sleep}
                  sub={scores.length ? `median ${Math.round(median(scores))}, ${scores.length} nights` : "no nights logged"} />
            <Stat v={hoursArr.length ? minsToHM(avg(hoursArr) * 60) : null} l="avg asleep" color={HEX.hours}
                  sub={hoursArr.length ? `${hoursArr.filter((h) => h >= settings.sleepHoursGoal).length} of ${hoursArr.length} hit ${settings.sleepHoursGoal}h` : ""} />
            <Stat v={rhrArr.length ? Math.round(avg(rhrArr)) : null} l="avg resting HR" color={HEX.rhr}
                  sub={rhrArr.length ? `${Math.min(...rhrArr)}–${Math.max(...rhrArr)} range` : ""} />
            <Stat v={rhrNow != null ? Math.round(rhrNow) : null} l="resting HR, last 7 nights"
                  color={rhrDelta == null ? HEX.rhr : rhrDelta >= 3 ? HEX.alert : rhrDelta <= -2 ? HEX.run : HEX.rhr}
                  sub={rhrDelta == null ? "needs a longer window"
                    : rhrDelta >= 3 ? `${rhrDelta} above your baseline of ${rhrNorm} — worth noticing`
                    : rhrDelta <= -2 ? `${Math.abs(rhrDelta)} below your baseline of ${rhrNorm}`
                    : `in line with your baseline of ${rhrNorm}`} />
            <Stat v={bbArr.length ? Math.round(avg(bbArr)) : null} l="avg body battery on waking" color={HEX.hours}
                  sub={bbArr.length ? `${Math.min(...bbArr)}–${Math.max(...bbArr)} range` : "add it on the Log tab"} />
            <Stat v={bedArr.length ? fmtBedtime(avg(bedArr)) : null} l="avg bedtime" color={HEX.sleep}
                  sub={bedArr.length ? `${fmtBedtime(Math.min(...bedArr))} to ${fmtBedtime(Math.max(...bedArr))}` : "add it on the Log tab"} />
            <Stat v={scores.length ? `${Math.round((scores.filter((s) => s >= settings.sleepScoreGoal).length / scores.length) * 100)}%` : null}
                  l={`nights at or above ${settings.sleepScoreGoal}`} color={HEX.sleep} />
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Score, body battery and hours <span className="hint">per {noun}</span></h2>
        <div className="body" style={{ paddingTop: 8 }}>
          <Chart h={220}>
            <ComposedChart data={chart} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={HEX.grid} vertical={false} />
              <XAxis dataKey="label" tick={axisTick()} interval={tickGap(chart.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
              <YAxis yAxisId="score" domain={[40, 100]} tick={axisTick()} tickLine={false} axisLine={false} />
              <YAxis yAxisId="hours" orientation="right" domain={[0, 10]} tick={axisTick()} tickLine={false} axisLine={false} />
              <Tooltip content={<Tip />} />
              <ReferenceLine yAxisId="score" y={settings.sleepScoreGoal} stroke={HEX.sleep} strokeDasharray="3 4" opacity={0.6} />
              <Bar yAxisId="hours" dataKey="hours" name="Hours" fill={HEX.hours} opacity={0.35} radius={[2, 2, 0, 0]} />
              <Line yAxisId="score" type="monotone" dataKey="score" name="Score" stroke={HEX.sleep} strokeWidth={2} dot={range <= 31 ? { r: 2.5 } : false} connectNulls />
              <Line yAxisId="score" type="monotone" dataKey="bb" name="Body battery" stroke={HEX.hours} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
              <Line yAxisId="score" type="monotone" dataKey="rhr" name="Resting HR" stroke={HEX.rhr} strokeWidth={1.8} strokeDasharray="1 3" dot={false} connectNulls />
            </ComposedChart>
          </Chart>
          <div className="legend">
            <span><i style={{ background: HEX.sleep }} />score (left, dashed = goal)</span>
            <span><i style={{ background: HEX.hours }} />body battery on waking (left, dashed)</span>
            <span><i style={{ background: HEX.rhr }} />resting HR (left, dotted) — it usually moves opposite the score</span>
            <span><i style={{ background: HEX.hours, opacity: 0.5 }} />hours (right)</span>
          </div>
        </div>
      </div>

      <div className="grid3">
        <div className="panel">
          <h2>Resting heart rate</h2>
          <div className="body" style={{ paddingTop: 8 }}>
            {rhrArr.length ? (
              <Chart h={170}>
                <LineChart data={chart} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke={HEX.grid} vertical={false} />
                  <XAxis dataKey="label" tick={axisTick()} interval={tickGap(chart.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
                  <YAxis domain={["dataMin - 3", "dataMax + 3"]} tick={axisTick()} tickLine={false} axisLine={false} />
                  <Tooltip content={<Tip />} />
                  {rhrNorm != null && <ReferenceLine y={rhrNorm} stroke={HEX.rhr} strokeDasharray="3 4" opacity={0.6} />}
                  <Line type="monotone" dataKey="rhr" name="RHR" stroke={HEX.rhr} strokeWidth={2} dot={range <= 31 ? { r: 2.5 } : false} connectNulls />
                </LineChart>
              </Chart>
            ) : <p className="empty">Add resting HR on the Log tab and it will chart here.</p>}
            {rhrNorm != null && <p className="note" style={{ marginTop: 6 }}>Dashed line is your baseline for this window, {rhrNorm} bpm.</p>}
            {rRhr != null && <p className="note" style={{ marginTop: 6 }}>RHR against score: {rWord(rRhr)} (r = {round(rRhr, 2)}).</p>}
          </div>
        </div>
        <div className="panel">
          <h2>Bedtime</h2>
          <div className="body" style={{ paddingTop: 8 }}>
            {bedArr.length ? (
              <Chart h={170}>
                <LineChart data={chart} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke={HEX.grid} vertical={false} />
                  <XAxis dataKey="label" tick={axisTick()} interval={tickGap(chart.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
                  <YAxis domain={["dataMin - 30", "dataMax + 30"]} tick={axisTick()} tickLine={false} axisLine={false} tickFormatter={(v) => fmtBedtime(v)} width={54} />
                  <Tooltip content={<Tip fmt={(p) => fmtBedtime(p.value)} />} />
                  <Line type="monotone" dataKey="bed" name="Bedtime" stroke={HEX.sleep} strokeWidth={2} dot={range <= 31 ? { r: 2.5 } : false} connectNulls />
                </LineChart>
              </Chart>
            ) : <p className="empty">Add bedtime on the Log tab and it will chart here.</p>}
            {rBed != null && <p className="note" style={{ marginTop: 6 }}>Later bedtime against score: {rWord(rBed)} (r = {round(rBed, 2)}){rBed < -0.2 ? ". Earlier nights are scoring better." : "."}</p>}
          </div>
        </div>
        <div className="panel">
          <h2>By weekday <span className="hint">avg score</span></h2>
          <div className="body" style={{ paddingTop: 8 }}>
            <Chart h={170}>
              <BarChart data={weekday} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={HEX.grid} vertical={false} />
                <XAxis dataKey="day" tick={axisTick()} tickLine={false} axisLine={{ stroke: HEX.rule }} />
                <YAxis domain={[40, 100]} tick={axisTick()} tickLine={false} axisLine={false} />
                <Tooltip content={<Tip fmt={(p) => `${p.value} (${p.payload.n} nights)`} />} />
                <Bar dataKey="score" name="Score" radius={[2, 2, 0, 0]}>
                  {weekday.map((w, i) => <Cell key={i} fill={HEX.sleep} opacity={w.score != null && w.score >= settings.sleepScoreGoal ? 0.9 : 0.5} />)}
                </Bar>
              </BarChart>
            </Chart>
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>What the day before does to the night</h2>
          <div className="body">
            <table>
              <thead><tr><th>Condition</th><th className="num">Avg score</th><th className="num">Nights</th></tr></thead>
              <tbody>
                <tr><td>After drinking</td><td className="num" style={{ color: kindHex("alcohol") }}>{afterDrinks.length ? Math.round(avg(afterDrinks)) : "—"}</td><td className="num">{afterDrinks.length}</td></tr>
                <tr><td>Dry day before</td><td className="num">{dry.length ? Math.round(avg(dry)) : "—"}</td><td className="num">{dry.length}</td></tr>
                <tr><td>Trained the day before</td><td className="num" style={{ color: HEX.lift }}>{afterTrain.length ? Math.round(avg(afterTrain)) : "—"}</td><td className="num">{afterTrain.length}</td></tr>
                <tr><td>No training day before</td><td className="num">{noTrain.length ? Math.round(avg(noTrain)) : "—"}</td><td className="num">{noTrain.length}</td></tr>
                {tagRows.map((r) => (
                  <tr key={r.tag}>
                    <td>After a <span className="tag" style={{ background: "var(--sleep)" }}>{r.tag}</span> day</td>
                    <td className="num">{r.score ?? "—"}{r.bb != null ? <span style={{ color: "var(--faint)" }}> · bb {r.bb}</span> : ""}</td>
                    <td className="num">{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="note" style={{ marginTop: 10 }}>
              Drinks vs score: {rWord(rAlc)}{rAlc != null ? ` (r = ${round(rAlc, 2)})` : ""}. Caffeine vs score: {rWord(rCaf)}{rCaf != null ? ` (r = ${round(rCaf, 2)})` : ""}.
              Small samples swing a lot; widen the range for steadier numbers.
            </p>
          </div>
        </div>
        <div className="panel">
          <h2>Recent nights</h2>
          <div className="body">
            {recent.length ? (
              <table>
                <thead><tr><th>Night</th><th className="num">Score</th><th className="num">Asleep</th><th className="num">Battery</th><th className="num">RHR</th><th className="num">Bed</th></tr></thead>
                <tbody>
                  {recent.map((s) => (
                    <tr key={s.date}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtShort(s.date)}</td>
                      <td className="num" style={{ color: s.score != null && s.score >= settings.sleepScoreGoal ? HEX.lift : undefined }}>{s.score ?? "—"}</td>
                      <td className="num">{minsToHM(s.asleepMin)}</td>
                      <td className="num">{s.bodyBattery ?? "—"}</td>
                      <td className="num">{s.restingHr ?? "—"}</td>
                      <td className="num">{s.bedtime ? fmtBedtime(bedtimeMins(s.bedtime)) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="empty">No nights yet.</p>}
          </div>
        </div>
      </div>
    </>
  );
}

/* ================================================================== */
/* Training                                                           */
/* ================================================================== */

function TrainingDash({ sessions, days: dayRecs, doses, sleep, settings, setSettings, range }) {
  const daily = useDaily({ doses, sleep, sessions, days: dayRecs, settings });
  const today = toDayKey(new Date());
  const u = settings.distanceUnit;
  const span = lastNDays(range, today);
  const spanSet = new Set(span);
  const inRange = sessions.filter((s) => spanSet.has(s.date));
  const runs = inRange.filter((s) => s.kind === "run");
  const lifts = inRange.filter((s) => s.kind === "lift");
  const rests = inRange.filter((s) => s.kind === "rest");

  const buckets = bucketize(span, range);
  const noun = bucketNoun(range);
  const targetPer = noun === "day" ? settings.weeklyDistanceTarget / 7 : noun === "week" ? settings.weeklyDistanceTarget : settings.weeklyDistanceTarget * 4.35;
  const chart = buckets.map((b) => ({
    label: b.label,
    dist: round(toUnit(bucketSum(b, (k) => daily.get(k).runKm), u), 1) ?? 0,
    runs: b.days.filter((k) => daily.get(k).hasRun).length,
    lifts: b.days.filter((k) => daily.get(k).hasLift).length,
    pace: (() => { const p = b.days.map((k) => daily.get(k).paceSecKm).filter(Boolean); return p.length ? round(u === "mi" ? avg(p) * KM_PER_MI : avg(p), 0) : null; })(),
  }));

  const runMix = RUN_TYPES.map((t) => ({ type: t, n: runs.filter((r) => r.type === t).length, km: sum(runs.filter((r) => r.type === t).map((r) => r.distanceKm || 0)) })).filter((x) => x.n);
  const liftMix = LIFT_TYPES.map((t) => ({ type: t, n: lifts.filter((r) => r.type === t).length })).filter((x) => x.n);

  const totalKm = sum(runs.map((r) => r.distanceKm || 0));
  const paced = runs.map((r) => ({ p: paceSecOf(r, u), d: r.distanceKm || 0 })).filter((x) => x.p);
  const avgPace = paced.length ? (paced.every((x) => x.d) ? sum(paced.map((x) => x.p * toUnit(x.d, u))) / toUnit(sum(paced.map((x) => x.d)), u) : avg(paced.map((x) => x.p))) : null;
  const longest = runs.reduce((a, r) => ((r.distanceKm || 0) > (a?.distanceKm || 0) ? r : a), null);
  const stepsArr = span.map((k) => daily.get(k).steps).filter((x) => x != null);
  const weeks = Math.max(1, range / 7);

  const recent = [...sessions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts)).slice(0, 20);

  return (
    <>
      <ScorePanel which="run" daily={daily} settings={settings} range={range} />
      <ScoreRidges which="run" daily={daily} settings={settings} range={range} />
      <div className="panel">
        <h2>Training <span className="hint">last {range} days</span></h2>
        <div className="body">
          <div className="grid4" style={{ gap: 12 }}>
            <Stat v={round(toUnit(totalKm, u), 1) ?? 0} l={`${u} run`} color={HEX.run}
                  sub={`${runs.length} run${runs.length === 1 ? "" : "s"}, ${round(toUnit(totalKm, u) / weeks, 1)} ${u}/week`} />
            <Stat v={avgPace ? secsToClock(avgPace) : null} l={`avg pace per ${u}`} color={HEX.run}
                  sub={longest?.distanceKm ? `longest ${round(toUnit(longest.distanceKm, u), 1)} ${u} (${longest.type})` : ""} />
            <Stat v={lifts.length} l={lifts.length === 1 ? "lift" : "lifts"} color={HEX.lift}
                  sub={liftMix.length ? liftMix.map((m) => `${m.n} ${m.type}`).join(", ") : ""} />
            <Stat v={stepsArr.length ? `${Math.round(avg(stepsArr) / 100) / 10}k` : null} l="steps / day" color={HEX.lift}
                  sub={stepsArr.length ? `${stepsArr.filter((x) => x >= settings.stepsGoal).length} of ${stepsArr.length} days over ${settings.stepsGoal / 1000}k · ${rests.length} rest days` : `${rests.length} rest days logged`} />
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Mileage and pace <span className="hint">per {noun}; dashed line = target, pace on the right</span></h2>
        <div className="body" style={{ paddingTop: 8 }}>
          <Chart h={210}>
            <ComposedChart data={chart} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={HEX.grid} vertical={false} />
              <XAxis dataKey="label" tick={axisTick()} interval={tickGap(chart.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
              <YAxis yAxisId="dist" tick={axisTick()} tickLine={false} axisLine={false} />
              <YAxis yAxisId="pace" orientation="right" reversed domain={["dataMin - 30", "dataMax + 30"]} tick={axisTick()} tickLine={false} axisLine={false} tickFormatter={(v) => secsToClock(v)} width={44} />
              <Tooltip content={<Tip fmt={(p) => p.dataKey === "dist" ? `${p.value} ${u}` : p.dataKey === "pace" ? `${secsToClock(p.value)}/${u}` : p.value} />} />
              <ReferenceLine yAxisId="dist" y={round(targetPer, 1)} stroke={HEX.run} strokeDasharray="3 4" opacity={0.6} />
              <Bar yAxisId="dist" dataKey="dist" name="Distance" radius={[2, 2, 0, 0]}>
                {chart.map((w, i) => <Cell key={i} fill={HEX.run} opacity={w.dist >= targetPer ? 0.95 : 0.55} />)}
              </Bar>
              <Line yAxisId="pace" type="monotone" dataKey="pace" name="Pace" stroke={HEX.sleep} strokeWidth={1.8} dot={range <= 31 ? { r: 2.5 } : false} connectNulls />
            </ComposedChart>
          </Chart>
          <div className="legend">
            <span><i style={{ background: HEX.run }} />{u} per {noun}</span>
            <span><i style={{ background: HEX.sleep }} />avg pace (up is faster)</span>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="f" style={{ width: 150 }}>Weekly target ({u})
              <input value={settings.weeklyDistanceTarget} inputMode="decimal"
                     onChange={(e) => setSettings({ ...settings, weeklyDistanceTarget: Number(e.target.value) || 0 })} />
            </label>
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Run mix</h2>
          <div className="body">
            {runMix.length ? (
              <table>
                <thead><tr><th>Type</th><th className="num">Runs</th><th className="num">{u}</th><th className="num">Share</th></tr></thead>
                <tbody>
                  {runMix.map((m) => (
                    <tr key={m.type}>
                      <td><span className="tag run">{m.type}</span></td>
                      <td className="num">{m.n}</td>
                      <td className="num">{round(toUnit(m.km, u), 1)}</td>
                      <td className="num">{totalKm ? `${Math.round((m.km / totalKm) * 100)}%` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="empty">No runs in this window.</p>}
          </div>
        </div>
        <div className="panel">
          <h2>Lift mix</h2>
          <div className="body">
            {liftMix.length ? (
              <table>
                <thead><tr><th>Type</th><th className="num">Sessions</th><th className="num">Share</th></tr></thead>
                <tbody>
                  {liftMix.map((m) => (
                    <tr key={m.type}>
                      <td><span className="tag lift">{m.type}</span></td>
                      <td className="num">{m.n}</td>
                      <td className="num">{Math.round((m.n / lifts.length) * 100)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="empty">No lifts in this window.</p>}
          </div>
        </div>
      </div>

      <AerobicCapacity daily={daily} range={range} />

      <Bests daily={daily} sessions={sessions} doses={doses} settings={settings} />

      <div className="grid2">
        <div className="panel">
          <h2>Race</h2>
          <div className="body">
            {(() => {
              const today = toDayKey(new Date());
              const next = (settings.races || []).filter((r) => r.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
              if (!next) return <p className="empty">No upcoming race. Add one on the Calendar tab and the countdown appears here.</p>;
              const days = Math.ceil((fromDayKey(next.date) - new Date()) / 864e5);
              return (
                <p className="note" style={{ color: "var(--ink)" }}>
                  <b>{next.name || raceType(next.kind).name}</b> in {days} day{days === 1 ? "" : "s"} ({fmtDayLabel(next.date)})
                  {next.goalTime ? <> · goal {next.goalTime}{avgPace ? <>, which is {secsToClock(parseGoalTime(next.goalTime) / (Number(next.distanceMi) || raceType(next.kind).miles))}/{u} against your recent {secsToClock(avgPace)}/{u}</> : null}</> : null}
                  <br />Races and the training plan live on the Calendar tab.
                </p>
              );
            })()}
          </div>
        </div>
        <div className="panel">
          <h2>Recent sessions</h2>
          <div className="body">
            {recent.length ? (
              <table>
                <thead><tr><th>Date</th><th>Session</th><th className="num">Detail</th></tr></thead>
                <tbody>
                  {recent.map((s) => (
                    <tr key={s.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{fmtShort(s.date)}</td>
                      <td><span className={`tag ${s.kind}`} style={{ marginRight: 6 }}>{s.kind === "rest" ? "rest" : s.type}</span>{s.note || (s.source !== "manual" ? s.name : "")}</td>
                      <td className="num" style={{ whiteSpace: "nowrap" }}>
                        {s.distanceKm ? `${round(toUnit(s.distanceKm, u), 1)} ${u}` : ""}
                        {paceSecOf(s, u) ? `${s.distanceKm ? " · " : ""}${secsToClock(paceSecOf(s, u))}/${u}` : ""}
                        {s.sets ? `${s.sets} sets` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <p className="empty">Log a workout on the Log tab or connect Strava on the Data tab.</p>}
          </div>
        </div>
      </div>
    </>
  );
}

function RacesWrap({ doses, sleep, sessions, days, settings, setSettings }) {
  const daily = useDaily({ doses, sleep, sessions, days, settings });
  return (
    <>
      <Races settings={settings} setSettings={setSettings} daily={daily} />
      <FindRaces settings={settings} setSettings={setSettings} />
    </>
  );
}

function CalendarWrap({ doses, sleep, sessions, days, settings, setSettings, planned, setPlanned }) {
  const daily = useDaily({ doses, sleep, sessions, days, settings });
  return <Calendar daily={daily} settings={settings} setSettings={setSettings} planned={planned} setPlanned={setPlanned} />;
}

function SpendDashWrap({ doses, sleep, sessions, days, spend, setSpend, settings, setSettings, range }) {
  const daily = useDaily({ doses, sleep, sessions, days, settings });
  return <SpendDash spend={spend} setSpend={setSpend} daily={daily} settings={settings} setSettings={setSettings} range={range} doses={doses} />;
}

/* Spend, joined to the rest of the log. "Going out" is the only bucket that correlates
   with anything here, so it leads. */
function SpendDash({ spend, setSpend, daily, settings, setSettings, range, doses }) {
  const today = toDayKey(new Date());
  const u = settings.currency || "$";
  const max = settings.peerSocialMax ?? DEFAULT_SPEND_SETTINGS.peerSocialMax;
  const span = lastNDays(range, today);
  const spanSet = new Set(span);

  const resolved = useMemo(() => resolveBuckets(spend || [], daily.get, { peerSocialMax: max }), [spend, daily, max]);
  const byDay = useMemo(() => spendByDay(resolved), [resolved]);
  const inRange = resolved.filter((t) => spanSet.has(t.date));

  const money = (n) => `${u}${Math.round(n).toLocaleString()}`;
  const tot = (b) => sum(inRange.filter((t) => t.bucket === b && t.amount > 0).map((t) => t.amount));
  const paidBack = sum(span.map((k) => byDay.get(k)?.peerIn || 0));
  const outGross = tot("out");
  const daysOut = span.filter((k) => (byDay.get(k)?.out || 0) > 0).length;
  const weeks = Math.max(1, range / 7);

  const buckets = bucketize(span, range);
  const noun = bucketNoun(range);
  const chart = buckets.map((b) => ({
    label: b.label,
    out: round(bucketSum(b, (k) => byDay.get(k)?.out), 0) || 0,
    home: round(bucketSum(b, (k) => byDay.get(k)?.home), 0) || 0,
    other: round(bucketSum(b, (k) => byDay.get(k)?.other), 0) || 0,
  }));

  // going out against Degen, the whole point of joining the two
  const idx = useMemo(() => new Map(buildIndices(daily, span, settings).map((r) => [r.date, r])), [daily, span, settings]);
  const scatter = span.map((k) => ({ date: k, spend: byDay.get(k)?.out || 0, degen: idx.get(k)?.degen ?? null }))
    .filter((p) => p.spend > 0 && p.degen != null);
  const r = scatter.length >= 4 ? pearson(scatter.map((p) => p.degen), scatter.map((p) => p.spend)) : null;

  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const weekday = DOW.map((name, i) => {
    const dow = (i + 1) % 7;
    const days = span.filter((k) => fromDayKey(k).getDay() === dow);
    return { day: name, spend: round(sum(days.map((k) => byDay.get(k)?.out || 0)), 0) };
  });

  const big = [...byDay.values()].filter((x) => spanSet.has(x.date) && x.out > 0)
    .sort((a, b) => b.out - a.out).slice(0, 8);

  const last = spend?.length ? [...spend].map((t) => t.date).sort().pop() : null;
  const stale = last ? Math.floor((fromDayKey(today) - fromDayKey(last)) / 864e5) : null;

  return (
    <>
      <SpendImport spend={spend} setSpend={setSpend} settings={settings} />

      {!spend?.length ? null : (
        <>
          <div className="panel">
            <h2>Spend <span className="hint">last {range} days{stale != null ? ` · data runs to ${fmtShort(last)}` : ""}</span></h2>
            <div className="body">
              <div className="grid4" style={{ gap: 12 }}>
                <Stat v={money(outGross)} l="going out" color={kindHex("alcohol")}
                      sub={`${money(outGross / weeks)} a week · ${daysOut} days out`} />
                <Stat v={money(outGross - paidBack)} l="net of what came back" color={kindHex("alcohol")}
                      sub={paidBack ? `${money(paidBack)} returned by friends` : "nothing returned"} />
                <Stat v={daysOut ? money(outGross / daysOut) : null} l="per day out" color={kindHex("alcohol")} />
                <Stat v={money(tot("home"))} l="at home" color={kindHex("cannabis")}
                      sub={`subscriptions, gaming, betting`} />
                <Stat v={money(tot("other"))} l="everything else" color={HEX.rest} />
                <Stat v={money(tot("peer"))} l="peer payments out" color={HEX.rhr}
                      sub={`under ${u}${max} on a drinking day counts as going out`} />
              </div>
              {stale != null && stale > 30 && (
                <p className="note flag" style={{ marginTop: 10 }}>
                  Your spend data is {stale} days old. Pull a fresh Rocket Money export.
                </p>
              )}
            </div>
          </div>

          <div className="panel">
            <h2>Where it goes <span className="hint">per {noun}</span></h2>
            <div className="body" style={{ paddingTop: 8 }}>
              <Chart h={220}>
                <BarChart data={chart} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid stroke={HEX.grid} vertical={false} />
                  <XAxis dataKey="label" tick={axisTick()} interval={tickGap(chart.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
                  <YAxis tick={axisTick()} tickLine={false} axisLine={false} tickFormatter={(v) => `${u}${v >= 1000 ? `${Math.round(v / 100) / 10}k` : v}`} />
                  <Tooltip content={<Tip fmt={(p) => money(p.value)} />} />
                  <Bar dataKey="out" name="Going out" stackId="a" fill={kindHex("alcohol")} />
                  <Bar dataKey="home" name="At home" stackId="a" fill={kindHex("cannabis")} />
                  <Bar dataKey="other" name="Everything else" stackId="a" fill={HEX.rest} radius={[2, 2, 0, 0]} />
                </BarChart>
              </Chart>
              <div className="legend">
                {Object.entries(SPEND_BUCKETS).filter(([k]) => k !== "peer").map(([k, m]) => (
                  <span key={k}><i style={{ background: k === "out" ? kindHex("alcohol") : k === "home" ? kindHex("cannabis") : HEX.rest }} />{m.name}: {m.hint}</span>
                ))}
              </div>
            </div>
          </div>

          <div className="grid2">
            <div className="panel">
              <h2>Going out by weekday</h2>
              <div className="body" style={{ paddingTop: 8 }}>
                <Chart h={180}>
                  <BarChart data={weekday} margin={{ top: 6, right: 8, left: -8, bottom: 0 }}>
                    <CartesianGrid stroke={HEX.grid} vertical={false} />
                    <XAxis dataKey="day" tick={axisTick()} tickLine={false} axisLine={{ stroke: HEX.rule }} />
                    <YAxis tick={axisTick()} tickLine={false} axisLine={false} tickFormatter={(v) => `${u}${v >= 1000 ? `${Math.round(v / 100) / 10}k` : v}`} />
                    <Tooltip content={<Tip fmt={(p) => money(p.value)} />} />
                    <Bar dataKey="spend" name="Going out" radius={[2, 2, 0, 0]}>
                      {weekday.map((d, i) => <Cell key={i} fill={d.day === "Fri" || d.day === "Sat" ? HEX.alert : kindHex("alcohol")} />)}
                    </Bar>
                  </BarChart>
                </Chart>
              </div>
            </div>
            <div className="panel">
              <h2>Spend against Degen <span className="hint">each dot is a day you went out</span></h2>
              <div className="body" style={{ paddingTop: 8 }}>
                {scatter.length < 4 ? <p className="empty">Not enough overlapping days yet.</p> : (
                  <>
                    <Chart h={180}>
                      <ScatterChart margin={{ top: 8, right: 10, left: -8, bottom: 2 }}>
                        <CartesianGrid stroke={HEX.grid} />
                        <XAxis type="number" dataKey="degen" name="Degen" domain={[0, 100]} tick={axisTick()} tickLine={false} axisLine={{ stroke: HEX.rule }} />
                        <YAxis type="number" dataKey="spend" name="Spend" tick={axisTick()} tickLine={false} axisLine={false} tickFormatter={(v) => `${u}${v}`} />
                        <Tooltip content={({ active, payload }) => {
                          if (!active || !payload?.length) return null;
                          const d = payload[0].payload;
                          return <div className="rc-tip"><b>{fmtDayLabel(d.date)}</b><div>{money(d.spend)} · Degen {Math.round(d.degen)}</div></div>;
                        }} />
                        <Scatter data={scatter} fill={kindHex("alcohol")} fillOpacity={0.6} />
                      </ScatterChart>
                    </Chart>
                    <p className="note" style={{ marginTop: 6 }}>
                      {r == null ? "" : Math.abs(r) < 0.2 ? "Spend and intake barely track each other — the expensive nights are not always the heavy ones."
                        : r > 0 ? `Heavier nights do cost more (r = ${round(r, 2)}).`
                        : `Oddly, heavier nights cost less (r = ${round(r, 2)}).`}
                    </p>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="panel">
            <h2>The expensive ones</h2>
            <div className="body">
              <table>
                <thead><tr><th>Day</th><th className="num">Out</th><th className="num">Back</th><th>What you logged</th></tr></thead>
                <tbody>
                  {big.map((x) => {
                    const d = daily.get(x.date);
                    return (
                      <tr key={x.date}>
                        <td style={{ whiteSpace: "nowrap" }}>{fmtDayLabel(x.date)}</td>
                        <td className="num">{money(x.out)}</td>
                        <td className="num" style={{ color: "var(--faint)" }}>{x.peerIn ? money(x.peerIn) : ""}</td>
                        <td style={{ color: "var(--soft)" }}>
                          {[d.alc ? `${round(d.alc, 1)} drinks` : null, d.thcMg ? `${round(d.thcMg, 1)} mg THC` : null,
                            d.sleep?.score != null ? `slept ${d.sleep.score}` : null, d.note || null].filter(Boolean).join(" · ") || "nothing logged"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/* Paste or drop a Rocket Money export. Re-importing is safe: rows are keyed and merge. */
function SpendImport({ spend, setSpend, settings }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [done, setDone] = useState(null);
  const fileRef = useRef(null);

  const read = (csv) => {
    setDone(null);
    const parsed = Papa.parse(csv.trim(), { header: true, skipEmptyLines: true });
    if (!parsed.data?.length) { setPreview({ empty: true }); return; }
    const res = parseRocketMoney(parsed.data);
    if (!res.txns.length) { setPreview({ empty: true }); return; }
    const have = new Set((spend || []).map((t) => t.id));
    const fresh = res.txns.filter((t) => !have.has(t.id));
    setPreview({ ...res, fresh, already: res.txns.length - fresh.length });
  };

  const onFile = (ev) => {
    const f = ev.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => read(String(r.result));
    r.readAsText(f); ev.target.value = "";
  };

  const bring = () => {
    setSpend(mergeBy(spend || [], preview.fresh, (t) => t.id));
    setDone(preview.fresh.length);
    setPreview(null); setText("");
  };

  return (
    <div className="panel">
      <h2>Import from Rocket Money <span className="hint">export everything; already-imported rows are skipped</span></h2>
      <div className="body">
        <div className="row" style={{ marginBottom: 10 }}>
          <a className="ghost" href="https://app.rocketmoney.com/transactions" target="_blank" rel="noreferrer"
             style={{ textDecoration: "none", padding: "6px 12px", display: "inline-block" }}>
            Open Rocket Money transactions
          </a>
          <button className="ghost" onClick={() => fileRef.current?.click()}>Choose the CSV</button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile} style={{ display: "none" }} />
          {done != null && <span className="note ok">Added {done} transaction{done === 1 ? "" : "s"}.</span>}
        </div>
        <p className="note" style={{ marginBottom: 10 }}>
          On that page: <b>Export</b>, no filters, then open the emailed link. Drop the file here. Export the full history every
          time — nothing duplicates, so there is no reason to narrow the dates.
        </p>
        <textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="…or paste the CSV contents here" />
        <div style={{ marginTop: 9 }}>
          <button className="solid" onClick={() => text.trim() && read(text)} disabled={!text.trim()}>Read it</button>
        </div>

        {preview?.empty && <p className="note flag" style={{ marginTop: 10 }}>Nothing read. That does not look like a Rocket Money export.</p>}
        {preview && !preview.empty && (
          <>
            <div className="divline" />
            <p className="note" style={{ marginBottom: 8 }}>
              <b>{preview.fresh.length} new</b> of {preview.txns.length}, {preview.span[0]} to {preview.span[1]}.
              {preview.already ? ` ${preview.already} already in.` : ""}
              {preview.skipped ? ` ${preview.skipped} skipped as transfers, payments or investments.` : ""}
            </p>
            <div className="chips" style={{ marginBottom: 10 }}>
              {Object.entries(SPEND_BUCKETS).map(([k, m]) => {
                const n = preview.fresh.filter((t) => t.bucket === k || (k === "out" && t.bucket === "ride")).length;
                return n ? <span key={k} className="chip" style={{ cursor: "default" }}>{m.name}<span className="amt">{n}</span></span> : null;
              })}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="solid" onClick={bring} disabled={!preview.fresh.length}>Import {preview.fresh.length}</button>
              <button className="ghost" onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* Finding races, and knowing when entry opens.

   Two sources, deliberately: RunSignup's API for the thousands of ordinary road races,
   queried live because their terms forbid keeping a copy; and a short curated list for
   the majors, whose entry is lotteries and qualifying windows that no API exposes. */
function FindRaces({ settings, setSettings }) {
  const today = toDayKey(new Date());
  const [tab, setTab] = useState("soon");
  const [q, setQ] = useState({ distance: "marathon", zip: "11101", radius: "50", months: 12 });
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const known = new Set((settings.races || []).map((r) => `${r.date}|${(r.name || "").toLowerCase()}`));
  const add = (r) => {
    const row = { id: uid(), date: r.date, name: r.name, kind: r.kind || guessKind(r.distance || 26.2),
      distanceMi: r.distanceMi ?? r.distance ?? raceType(r.kind).miles, goalTime: "", resultTime: "", notes: r.url || "" };
    setSettings({ ...settings, races: [...(settings.races || []), row].sort((a, b) => (a.date < b.date ? 1 : -1)) });
  };

  const search = async () => {
    setBusy(true); setErr(""); setRows(null);
    try {
      const to = addDays(today, Math.round(q.months * 30.44));
      const p = new URLSearchParams({ from: today, to, distance: q.distance, zip: q.zip, radius: q.radius });
      const j = await callFn(`/.netlify/functions/race-search?${p}`);
      setRows(j.races || []);
    } catch (e) { setErr(String(e.message || e)); }
    finally { setBusy(false); }
  };

  const soon = actionable(today, { withinDays: 60 });

  return (
    <div className="panel">
      <h2>Find races
        <span className="seg" style={{ fontSize: 12 }}>
          <button aria-pressed={tab === "soon"} onClick={() => setTab("soon")} style={{ padding: "3px 9px", fontSize: 12 }}>Entry opening</button>
          <button aria-pressed={tab === "search"} onClick={() => setTab("search")} style={{ padding: "3px 9px", fontSize: 12 }}>Search</button>
        </span>
      </h2>
      <div className="body">
        {tab === "soon" ? (
          <>
            {!soon.length ? <p className="empty">No entry windows open or opening in the next two months.</p> : (
              <table>
                <thead><tr><th>Race</th><th>Entry</th><th className="num">Window</th><th /></tr></thead>
                <tbody>
                  {soon.map((m) => {
                    const st = m.status;
                    const colour = m.urgency === "closing" ? HEX.alert : m.urgency === "open" ? HEX.run : HEX.rest;
                    return (
                      <tr key={m.id}>
                        <td>
                          <a href={m.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)" }}>{m.name}</a>
                          <div className="note" style={{ color: "var(--faint)" }}>{m.city} · {raceType(m.kind).name}{m.note ? ` — ${m.note}` : ""}</div>
                        </td>
                        <td><span className="pill">{m.entry}</span></td>
                        <td className="num" style={{ color: colour, whiteSpace: "nowrap" }}>
                          {st.state === "open" ? (st.closesIn <= 7 ? `closes in ${st.closesIn}d` : `open, ${st.closesIn}d left`) : `opens in ${st.opensIn}d`}
                        </td>
                        <td><button className="ghost" onClick={() => add({ date: `${fromDayKey(today).getFullYear() + (m.month < fromDayKey(today).getMonth() + 1 ? 1 : 0)}-${String(m.month).padStart(2, "0")}-01`, name: m.name, kind: m.kind, url: m.url })}>Track</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
            <p className="note" style={{ marginTop: 10, color: "var(--faint)" }}>
              Hand-maintained, because lotteries and qualifying windows are not in any public API. Dates shift year to year —
              check the official page before you rely on one. "Track" adds it with a placeholder date you can correct.
            </p>
          </>
        ) : (
          <>
            <div className="row">
              <label className="f" style={{ width: 118 }}>Distance
                <select value={q.distance} onChange={(e) => setQ({ ...q, distance: e.target.value })}>
                  <option value="any">Any</option>
                  {Object.entries(RACE_TYPES).map(([k, t]) => <option key={k} value={k}>{t.name}</option>)}
                  <option value="ultra">Ultra</option>
                </select>
              </label>
              <label className="f" style={{ width: 92 }}>Near ZIP<input value={q.zip} onChange={(e) => setQ({ ...q, zip: e.target.value })} /></label>
              <label className="f" style={{ width: 92 }}>Within (mi)<input value={q.radius} inputMode="numeric" onChange={(e) => setQ({ ...q, radius: e.target.value })} /></label>
              <label className="f" style={{ width: 104 }}>Next (months)<input value={q.months} inputMode="numeric" onChange={(e) => setQ({ ...q, months: Number(e.target.value) || 12 })} /></label>
              <button className="solid" onClick={search} disabled={busy}>{busy ? "Searching…" : "Search"}</button>
            </div>
            {err && <p className="note flag" style={{ marginTop: 10 }}>{err}</p>}
            {rows && !rows.length && <p className="empty">Nothing found. Widen the radius or the distance.</p>}
            {rows && rows.length > 0 && (
              <table style={{ marginTop: 12 }}>
                <thead><tr><th>Date</th><th>Race</th><th>Where</th><th className="num">{settings.distanceUnit}</th><th /></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.date ? fmtShort(r.date) : "—"}</td>
                      <td><a href={r.url} target="_blank" rel="noreferrer" style={{ color: "var(--ink)" }}>{r.name}</a>
                        {r.eventName && <div className="note" style={{ color: "var(--faint)" }}>{r.eventName}</div>}</td>
                      <td style={{ color: "var(--soft)" }}>{[r.city, r.state].filter(Boolean).join(", ")}</td>
                      <td className="num">{r.distance ? round(r.distance, 1) : ""}</td>
                      <td>
                        {known.has(`${r.date}|${(r.name || "").toLowerCase()}`)
                          ? <span className="note ok">added</span>
                          : <button className="ghost" onClick={() => add(r)}>Add</button>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="note" style={{ marginTop: 10, color: "var(--faint)" }}>
              Live from RunSignup, which covers most US road races. Nothing is stored — their terms ask that their
              data is not copied, so every search goes to them fresh.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

/* Every race, past and future. Past ones with a result become the thing that predicts
   your next one; the soonest future one is what the plan is built toward. */
function Races({ settings, setSettings, daily, onPickTarget }) {
  const today = toDayKey(new Date());
  const races = settings.races || [];
  const [draft, setDraft] = useState(null);

  const save = (r) => {
    const rows = r.id ? races.map((x) => (x.id === r.id ? r : x)) : [...races, { ...r, id: uid() }];
    setSettings({ ...settings, races: rows.sort((a, b) => (a.date < b.date ? 1 : -1)) });
    setDraft(null);
  };
  const remove = (id) => setSettings({ ...settings, races: races.filter((r) => r.id !== id) });

  const past = races.filter((r) => r.date <= today);
  const future = races.filter((r) => r.date > today).sort((a, b) => (a.date < b.date ? -1 : 1));
  const target = future[0] || null;
  const best = bestFromRaces(races, raceType(target?.kind).miles, today);

  /* Anything in the log that looks like a race, offered once so you do not retype it. */
  const found = useMemo(() => {
    const known = new Set(races.map((r) => r.date));
    const pat = /\b(marathon|half|10 ?k|5 ?k|race|championship|turkey trot|relay|classic|invitational)\b/i;
    const out = [];
    for (const [date, x] of daily.byDay) {
      if (known.has(date) || date > today) continue;
      for (const sess of x.sessions) {
        if (sess.kind !== "run" || !sess.distanceKm) continue;
        const isRace = sess.type === "race" || pat.test(sess.name || "");
        if (!isRace) continue;
        const mi = toUnit(sess.distanceKm, settings.distanceUnit);
        if (mi < 3) continue;
        const sec = sess.movingSec || (sess.paceSecPerKm ? sess.paceSecPerKm * sess.distanceKm : null);
        out.push({ date, name: (sess.name || "Race").slice(0, 44), distanceMi: round(mi, 2),
          resultTime: sec ? secsToClock(sec) : "", kind: guessKind(mi), status: "entered" });
      }
    }
    return out.sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 8);
  }, [daily, races, settings.distanceUnit, today]);

  const Row = ({ r }) => {
    const sec = parseTime(r.resultTime), goal = parseTime(r.goalTime);
    const mi = Number(r.distanceMi) || raceType(r.kind).miles;
    return (
      <tr>
        <td style={{ whiteSpace: "nowrap" }}>{fmtShort(r.date)}{r.date > today && <span className="pill" style={{ marginLeft: 6 }}>upcoming</span>}</td>
        <td>{r.name || raceType(r.kind).name}</td>
        <td className="num">{round(mi, 1)}</td>
        <td className="num">{r.goalTime || ""}</td>
        <td className="num" style={{ color: sec && goal ? (sec <= goal ? HEX.run : HEX.alert) : undefined }}>
          {r.resultTime || (r.date > today ? "—" : "")}
        </td>
        <td className="num" style={{ color: "var(--faint)" }}>{sec ? `${secsToClock(sec / mi)}/${settings.distanceUnit}` : ""}</td>
        <td style={{ whiteSpace: "nowrap" }}>
          <button className="del" onClick={() => setDraft({ ...r })} title="Edit">✎</button>
          <button className="del" onClick={() => remove(r.id)} title="Delete">×</button>
        </td>
      </tr>
    );
  };

  return (
    <div className="panel">
      <h2>Races <span className="hint">{target ? `next: ${target.name || raceType(target.kind).name} on ${fmtShort(target.date)}` : "nothing upcoming"}</span></h2>
      <div className="body">
        {races.length > 0 && (
          <table style={{ marginBottom: 12 }}>
            <thead><tr><th>Date</th><th>Race</th><th className="num">{settings.distanceUnit}</th><th className="num">Goal</th><th className="num">Result</th><th className="num">Pace</th><th /></tr></thead>
            <tbody>
              {future.map((r) => <Row key={r.id} r={r} />)}
              {past.map((r) => <Row key={r.id} r={r} />)}
            </tbody>
          </table>
        )}

        {best && target && (
          <p className="note" style={{ marginBottom: 10 }}>
            Your best predictor is <b>{best.name || "a past race"}</b> ({best.resultTime} over {round(best.miles, 1)} {settings.distanceUnit},
            {" "}{best.months} months ago) → equivalent <b>{secsToClock(best.predicted)}</b> for {raceType(target.kind).name.toLowerCase()}.
            {best.considered?.some((c) => c.tooShort) && " Shorter races are listed but not used to predict — they flatter anyone who has not done the long runs."}
          </p>
        )}

        {found.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <p className="note" style={{ marginBottom: 6 }}>Found in your log, not yet saved as races:</p>
            <div className="chips">
              {found.map((f) => (
                <button key={f.date} className="tchip" onClick={() => setDraft(f)}>
                  {fmtShort(f.date)} · {f.name.slice(0, 22)} · {f.distanceMi} {settings.distanceUnit}
                </button>
              ))}
            </div>
          </div>
        )}

        {!draft ? (
          <button className="solid" onClick={() => setDraft({ date: "", name: "", kind: "marathon", distanceMi: 26.2, goalTime: "", resultTime: "" })}>
            Add a race
          </button>
        ) : (
          <>
            <div className="divline" />
            <div className="row">
              <label className="f" style={{ width: 146 }}>Date<input type="date" value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} /></label>
              <label className="f" style={{ flex: 1, minWidth: 130 }}>Name<input value={draft.name} placeholder="CIM" onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
              <label className="f" style={{ width: 112 }}>Distance
                <select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value, distanceMi: RACE_TYPES[e.target.value].miles })}>
                  {Object.entries(RACE_TYPES).map(([k, t]) => <option key={k} value={k}>{t.name}</option>)}
                </select>
              </label>
              <label className="f" style={{ width: 84 }}>Exact {settings.distanceUnit}
                <input value={draft.distanceMi} inputMode="decimal" onChange={(e) => setDraft({ ...draft, distanceMi: Number(e.target.value) || 0 })} />
              </label>
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <label className="f" style={{ width: 112 }}>Goal time<input value={draft.goalTime || ""} placeholder="3:30:00" onChange={(e) => setDraft({ ...draft, goalTime: e.target.value })} /></label>
              <label className="f" style={{ width: 112 }}>Result<input value={draft.resultTime || ""} placeholder="3:20:38" onChange={(e) => setDraft({ ...draft, resultTime: e.target.value })} /></label>
              <label className="f" style={{ flex: 1, minWidth: 140 }}>Notes<input value={draft.notes || ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} /></label>
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button className="solid" onClick={() => draft.date && save(draft)} disabled={!draft.date}>Save</button>
              <button className="ghost" onClick={() => setDraft(null)}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const guessKind = (mi) =>
  mi >= 40 ? "50mi" : mi >= 28 ? "50k" : mi >= 20 ? "marathon" : mi >= 11 ? "half" : mi >= 5 ? "10k" : mi >= 2.5 ? "5k" : "mile";

/* A chat that edits the stored plan. It proposes day-level changes; the code applies
   them to the records and refuses anything that breaks the shape of a taper. */
function PlanChat({ settings, setSettings, planned, setPlanned }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  const today = toDayKey(new Date());

  const apply = (ops) => {
    const rows = [...(planned || [])];
    const at = (d) => rows.findIndex((r) => r.date === d);
    const done = [], refused = [];
    const raceDate = settings.race?.date;
    for (const op of ops) {
      if (op.date && op.date < today) { refused.push(`${op.date} has already happened`); continue; }
      if (op.date === raceDate || op.to === raceDate || op.from === raceDate) { refused.push("race day cannot be changed"); continue; }
      if (op.op === "setDay") {
        const i = at(op.date);
        const row = { date: op.date, kind: op.kind || "run", title: op.title || "Run",
          miles: op.miles ?? null, pace: null, note: op.note || "",
          lift: op.lift ?? (i >= 0 ? rows[i].lift ?? null : null), edited: true };
        if (i >= 0) rows[i] = { ...rows[i], ...row }; else rows.push(row);
        done.push(`${op.date}: ${row.title}${row.miles ? ` ${row.miles}` : ""}${row.lift ? ` + ${row.lift}` : ""}`);
      } else if (op.op === "moveDay") {
        const a = at(op.from), b = at(op.to);
        if (a < 0) { refused.push(`nothing planned on ${op.from}`); continue; }
        const body = (r) => ({ kind: r.kind, title: r.title, miles: r.miles, pace: r.pace, note: r.note });
        const A = body(rows[a]);
        const B = b >= 0 ? body(rows[b]) : { kind: "rest", title: "Rest", miles: null, pace: null, note: "" };
        rows[a] = { ...rows[a], ...B, edited: true };
        if (b >= 0) rows[b] = { ...rows[b], ...A, edited: true };
        else rows.push({ date: op.to, ...A, edited: true });
        done.push(`swapped ${op.from} and ${op.to}`);
      } else if (op.op === "scaleWeek") {
        const mon = op.monday;
        const f = Number(op.factor);
        if (!(f > 0.4 && f < 1.8)) { refused.push("that is too big a change to a week"); continue; }
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].date >= mon && rows[i].date < addDays(mon, 7) && rows[i].date >= today && rows[i].miles) {
            rows[i] = { ...rows[i], miles: round(rows[i].miles * f, 1), edited: true };
          }
        }
        done.push(`week of ${mon} scaled by ${f}`);
      } else refused.push(`"${op.op}" is not something I can do`);
    }
    if (done.length) setPlanned(rows);
    return { done, refused };
  };

  const send = async (override) => {
    const message = (override ?? text).trim();
    if (!message || busy) return;
    setText(""); setBusy(true);
    const history = [...msgs, { role: "user", text: message }];
    setMsgs(history);
    try {
      const j = await callFn("/.netlify/functions/plan-chat", {
        method: "POST",
        body: { message, history: msgs.slice(-6), plan: (planned || []).filter((d) => d.date >= today).slice(0, 80) },
      });
      const res = j.operations?.length ? apply(j.operations) : { done: [], refused: [] };
      setMsgs([...history, { role: "coach", text: j.reply, done: res.done, refused: res.refused }]);
    } catch (e) {
      setMsgs([...history, { role: "coach", text: String(e.message || e), error: true }]);
    } finally { setBusy(false); setTimeout(() => boxRef.current?.scrollTo({ top: 1e6 }), 50); }
  };

  const examples = ["Add a 20 miler two weeks out", "Move Sunday's long run to Saturday", "Make next week 20% easier", "I'm travelling Thursday to Sunday"];

  return (
    <div className="panel">
      <h2>Tell it what you need <span className="hint">it edits the days; you can undo anything by editing them back</span></h2>
      <div className="body">
        {msgs.length > 0 && (
          <div ref={boxRef} className="chatbox">
            {msgs.map((m, i) => (
              <div key={i} className={`bubble ${m.role}${m.error ? " err" : ""}`}>
                {m.text}
                {m.done?.length > 0 && <div className="note" style={{ marginTop: 6, color: "var(--faint)" }}>{m.done.map((t, n) => <div key={n}>· {t}</div>)}</div>}
                {m.refused?.length > 0 && <div className="note" style={{ marginTop: 6, color: "var(--alert)" }}>{m.refused.map((t, n) => <div key={n}>· {t}</div>)}</div>}
              </div>
            ))}
            {busy && <div className="bubble coach" style={{ opacity: 0.6 }}>Thinking…</div>}
          </div>
        )}
        <div className="row">
          <label className="f" style={{ flex: 1, minWidth: 200 }}>
            <input value={text} placeholder="Add a 20 miler on the 15th" disabled={busy}
                   onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
          </label>
          <button className="solid" onClick={() => send()} disabled={busy || !text.trim()}>Send</button>
        </div>
        {!msgs.length && (
          <div className="chips" style={{ marginTop: 10 }}>
            {examples.map((x) => <button key={x} className="tchip" onClick={() => send(x)}>{x}</button>)}
          </div>
        )}
      </div>
    </div>
  );
}

/* The training calendar.

   The plan is DATA, not a formula. "Generate" writes a session record for every day
   between now and the race; after that nothing recomputes behind you — you edit days,
   drag them, or ask the chat to change them, and what you actually ran is layered on
   top from the log. History reaches back as far as you have run. */
function Calendar({ daily, settings, setSettings, planned, setPlanned }) {
  const today = toDayKey(new Date());
  // the soonest future race in the list is what the plan is built toward
  // only a race you have actually entered shapes training or appears on the grid
  const races = (settings.races || []).filter((r) => r.status === "entered" || r.date < today);
  const target = races.filter((r) => r.date >= today && r.status === "entered")
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
  const race = target ? { name: target.name, date: target.date, kind: target.kind, goalTime: target.goalTime } : {};
  const goalSec = parseGoalTime(race.goalTime);
  const ready = !!(race.date && goalSec && race.date >= today);
  const raceDates = useMemo(() => new Map(races.map((r) => [r.date, r])), [races]);
  const [pick, setPick] = useState(null);
  const [drag, setDrag] = useState(null);
  const [edit, setEdit] = useState(null);
  const [weeksBack, setWeeksBack] = useState(8);
  const u = settings.distanceUnit;

  const prefs = { ...DEFAULT_PREFS, ...(settings.planPrefs || {}) };
  const setPrefs = (patch) => setSettings({ ...settings, planPrefs: { ...prefs, ...patch } });

  const byDate = useMemo(() => new Map((planned || []).map((d) => [d.date, d])), [planned]);
  const hasPlan = (planned || []).length > 0;

  /* ---- generating: run the arithmetic once, then store what it produced ---- */
  const generate = (replace) => {
    try {
      const p = buildPlan({ todayKey: today, raceDate: race.date, raceName: race.name,
        raceKind: race.kind, goalSeconds: goalSec, daily, settings });
      const rows = p.weeks.flatMap((w) => w.days.map((d) => ({
        date: d.date, kind: d.kind, title: d.title,
        miles: d.miles ?? null, pace: d.pace ?? null, note: d.note || "",
        lift: d.kind === "lift" ? d.title : null,
      })));
      // keep anything you have already edited unless you asked to replace it
      const keep = replace ? new Map() : new Map((planned || []).filter((d) => d.edited).map((d) => [d.date, d]));
      setPlanned(rows.map((r) => keep.get(r.date) || r).concat(
        [...keep.values()].filter((d) => !rows.some((r) => r.date === d.date))));
    } catch (e) { console.error("generate:", e); }
  };

  const updateDay = (date, patch) =>
    setPlanned((planned || []).map((d) => (d.date === date ? { ...d, ...patch, edited: true } : d)));
  const addDay = (row) => setPlanned([...(planned || []).filter((d) => d.date !== row.date), { ...row, edited: true }]);
  const swapDays = (a, b) => {
    if (!a || !b || a === b) return;
    const A = byDate.get(a), B = byDate.get(b);
    const body = (x) => (x ? { kind: x.kind, title: x.title, miles: x.miles, pace: x.pace, note: x.note, lift: x.lift ?? null } : { kind: "rest", title: "Rest", miles: null, pace: null, note: "", lift: null });
    setPlanned((planned || []).map((d) =>
      d.date === a ? { ...d, ...body(B), edited: true }
      : d.date === b ? { ...d, ...body(A), edited: true } : d));
  };

  /* ---- the weeks shown: history behind, plan ahead ---- */
  const allDates = [...daily.byDay.keys()].sort();
  const firstLogged = allDates[0] || today;
  const planDates = (planned || []).map((d) => d.date).sort();
  const lastDate = race.date || planDates[planDates.length - 1] || today;
  const startFrom = (() => {
    const wanted = addDays(mondayOf(today), -7 * weeksBack);
    return wanted < firstLogged ? mondayOf(firstLogged) : wanted;
  })();

  const grid = useMemo(() => {
    const out = [];
    for (let monday = mondayOf(startFrom); monday <= lastDate; monday = addDays(monday, 7)) {
      const days = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(monday, i);
        if (date > lastDate) break;
        const x = daily.get(date);
        const plan = byDate.get(date) || null;
        const raceHere = raceDates.get(date) || null;
        const ranMi = round(toUnit(x.runKm, u), 1);
        days.push({
          date, dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][fromDayKey(date).getDay()],
          plan, race: raceHere, past: date < today, isToday: date === today,
          ran: ranMi || null, lifted: x.hasLift,
          pace: x.paceSecKm ? (u === "mi" ? x.paceSecKm * 1.609344 : x.paceSecKm) : null,
          sleep: x.sleep?.score ?? null, rhr: x.sleep?.restingHr ?? null,
          drinks: round(x.alc, 1) || 0, thc: round(x.thcMg, 1) || 0, note: x.note || "",
        });
      }
      const plannedMi = round(sum(days.map((d) => d.plan?.miles || 0)), 1);
      const ranMi = round(sum(days.map((d) => d.ran || 0)), 1);
      // a long range is mostly noise if weeks with nothing in them are kept
      if (!plannedMi && !ranMi && weeksBack > 12 && monday < mondayOf(today)) continue;
      out.push({ monday, days, plannedMi, ranMi,
        longPlanned: Math.max(0, ...days.map((d) => d.plan?.miles || 0)) || null,
        longRan: Math.max(0, ...days.map((d) => d.ran || 0)) || null });
    }
    return out;
  }, [startFrom, lastDate, daily, byDate, u, today, weeksBack]);

  const Setup = (
    <div className="panel">
      <h2>Plan settings <span className="hint">{target ? `building toward ${target.name || raceType(target.kind).name}` : "add an upcoming race above first"}</span></h2>
      <div className="body">
        <div className="row">
          <label className="f" style={{ width: 120 }}>Intervals ({u})
            <input value={prefs.intervalMiles} inputMode="decimal" onChange={(e) => setPrefs({ intervalMiles: Number(e.target.value) || 4 })} />
          </label>
          <label className="f" style={{ width: 130 }}>Long run day
            <select value={prefs.longRunDays[0]} onChange={(e) => { const d = Number(e.target.value); setPrefs({ longRunDays: [d, ...[0, 6, 5].filter((x) => x !== d)] }); }}>
              <option value={0}>Sunday</option><option value={6}>Saturday</option><option value={5}>Friday</option>
            </select>
          </label>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button className="solid" onClick={() => generate(false)} disabled={!ready}>
            {hasPlan ? "Fill in missing days" : "Generate the plan"}
          </button>
          {hasPlan && (
            <button className="ghost" onClick={() => { if (confirm("Replace every planned day, including your edits?")) generate(true); }}>
              Start over
            </button>
          )}
          {hasPlan && <span className="note">{(planned || []).filter((d) => d.edited).length} day{(planned || []).filter((d) => d.edited).length === 1 ? "" : "s"} edited by hand</span>}
        </div>
        {!ready && (
          <p className="note flag" style={{ marginTop: 8 }}>
            {(settings.races || []).some((r) => r.date >= today)
              ? "You have races on the shortlist but none marked as entered. Mark one entered on the Races tab, give it a goal time, and the plan can be generated."
              : "Add a race on the Races tab, mark it entered and give it a goal time, and the plan appears here."}
          </p>
        )}
      </div>
    </div>
  );

  return (
    <>
      {Setup}
      {hasPlan && <PlanChat settings={settings} setSettings={setSettings} planned={planned} setPlanned={setPlanned} />}

      <div className="panel">
        <h2>Calendar
          <span className="seg" style={{ fontSize: 12 }}>
            {[4, 8, 26, 104].map((w) => (
              <button key={w} aria-pressed={weeksBack === w} onClick={() => setWeeksBack(w)} style={{ padding: "3px 9px", fontSize: 12 }}>
                {w >= 104 ? "all" : w >= 26 ? "6mo" : `${w}w`}
              </button>
            ))}
          </span>
        </h2>
        <div className="body">
          <p className="note" style={{ marginBottom: 8 }}>
            Grey is what you ran; coloured is what the plan asks for. Tap any day to edit it, or drag one onto another to swap.
          </p>
          <div className="calwrap">
          <table className="cal">
            <colgroup>
              <col className="wkcol" />
              {[0, 1, 2, 3, 4, 5, 6].map((i) => <col key={i} className="daycol" />)}
              <col className="micol" />
            </colgroup>
            <thead><tr><th />{["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <th key={d}>{d}</th>)}<th>{u}</th></tr></thead>
            <tbody>
              {grid.map((w, wi) => {
                const byDow = {};
                for (const d of w.days) byDow[fromDayKey(d.date).getDay()] = d;
                const mon = fromDayKey(w.monday);
                const prev = wi > 0 ? fromDayKey(grid[wi - 1].monday) : null;
                const newMonth = !prev || prev.getMonth() !== mon.getMonth();
                return (
                  <tr key={w.monday} className={newMonth ? "newmonth" : ""}>
                    <td className="wklabel">
                      {newMonth && <b>{mon.toLocaleDateString(undefined, { month: "short" })}</b>}
                      {(() => {
                        // weeks to race is more use here than repeating Monday's date
                        if (!race.date) return mon.toLocaleDateString(undefined, { day: "numeric" });
                        const wks = Math.round((fromDayKey(race.date) - mon) / 864e5 / 7);
                        return wks > 0 ? <span>{wks}w out</span>
                          : wks === 0 ? <span style={{ color: HEX.alert }}>race</span>
                          : <span style={{ color: "var(--faint)" }}>{Math.abs(wks)}w ago</span>;
                      })()}
                    </td>
                    {[1, 2, 3, 4, 5, 6, 0].map((dow) => {
                      const d = byDow[dow];
                      if (!d) return <td key={dow} className="cell empty-cell" />;
                      const canDrag = !!d.plan && !d.past;
                      const hit = d.plan?.miles && d.ran ? d.ran / d.plan.miles : null;
                      return (
                        <td key={dow}
                            className={`cell${d.isToday ? " today" : ""}${d.past ? " past" : ""}${drag === d.date ? " dragging" : ""}${d.race ? " raceday" : ""}`}
                            draggable={canDrag}
                            onDragStart={canDrag ? () => setDrag(d.date) : undefined}
                            onDragOver={canDrag ? (e) => e.preventDefault() : undefined}
                            onDrop={canDrag ? (e) => { e.preventDefault(); swapDays(drag, d.date); setDrag(null); } : undefined}
                            onDragEnd={() => setDrag(null)}
                            onClick={() => { setPick(d); setEdit(null); }}>
                          <div className="dnum">{fromDayKey(d.date).getDate()}</div>
                          {d.race && (
                            <div className="dtitle" style={{ color: HEX.alert }}>
                              🏁 {d.race.name ? d.race.name.slice(0, 10) : raceType(d.race.kind).name}
                            </div>
                          )}
                          {d.race && (
                            <div className="dsub" style={{ color: HEX.alert }}>
                              {d.race.resultTime || d.race.goalTime || `${round(Number(d.race.distanceMi) || raceType(d.race.kind).miles, 1)} ${u}`}
                            </div>
                          )}
                          {!d.race && d.plan && (
                            <div className="dtitle" style={{ color: d.plan.kind === "race" ? HEX.alert : d.plan.kind === "lift" ? HEX.lift : d.plan.kind === "rest" ? HEX.rest : HEX.run }}>
                              {d.plan.kind === "rest" && !d.plan.lift ? "rest" : d.plan.miles ? `${d.plan.miles}` : "lift"}
                              {d.plan.lift && d.plan.kind !== "lift" && <span style={{ color: HEX.lift }}>+L</span>}
                              {d.plan.edited && <span style={{ color: "var(--navy)" }}>·</span>}
                            </div>
                          )}
                          {!d.race && d.plan && <div className="dsub">{d.plan.kind === "rest" && !d.plan.lift ? "" : (d.plan.kind === "lift" ? d.plan.title : d.plan.title.replace(" run", "").replace("Race-pace", "RP"))}{d.plan.lift && d.plan.kind !== "lift" ? ` · ${d.plan.lift.replace("Lift — ", "").replace("Push — upper", "push")}` : ""}</div>}
                          {(d.ran || d.lifted) && (
                            <div className={`dmark ${hit == null ? "done" : hit >= 0.85 ? "done" : hit >= 0.5 ? "short" : "short"}`}>
                              {d.ran ? `${d.ran}` : "lift"}{d.ran && d.lifted ? "+L" : ""}
                            </div>
                          )}
                          {d.past && !d.ran && !d.lifted && d.plan && d.plan.kind !== "rest" && <div className="dmark missed">×</div>}
                        </td>
                      );
                    })}
                    <td className="wkmiles">
                      {w.plannedMi ? <div style={{ color: HEX.run }}>{w.plannedMi}</div> : null}
                      {w.ranMi ? <div style={{ color: "var(--faint)" }}>{w.ranMi}</div> : null}
                      {!w.plannedMi && !w.ranMi ? <span style={{ color: "var(--faint)" }}>—</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
          <div className="legend">
            <span><i style={{ background: HEX.run }} />planned</span>
            <span><i style={{ background: HEX.rest }} />actually ran</span>
            <span><i style={{ background: HEX.alert }} />🏁 race day</span>
            <span>+L means a lift that day as well · × a planned session with nothing logged · a dot marks a day you edited</span>
          </div>
        </div>
      </div>

      {pick && (
        <div className="panel">
          <h2>{pick.dow} {fmtDayLabel(pick.date)}
            <button className="del" onClick={() => { setPick(null); setEdit(null); }} style={{ fontSize: 13 }}>close</button>
          </h2>
          <div className="body">
            {pick.race && (
              <p className="note" style={{ marginBottom: 10, color: HEX.alert, fontSize: 14 }}>
                <b>🏁 {pick.race.name || raceType(pick.race.kind).name}</b> · {round(Number(pick.race.distanceMi) || raceType(pick.race.kind).miles, 1)} {u}
                {pick.race.goalTime ? ` · goal ${pick.race.goalTime}` : ""}
                {pick.race.resultTime ? ` · ran ${pick.race.resultTime}` : ""}
                {pick.race.notes ? ` — ${pick.race.notes}` : ""}
              </p>
            )}
            {!edit ? (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  {pick.plan ? (
                    <>
                      <span className={`tag ${pick.plan.kind === "race" ? "run" : pick.plan.kind}`}>{pick.plan.kind}</span>
                      <b style={{ fontSize: 15 }}>{pick.plan.title}</b>
                      {pick.plan.miles ? <span className="note">{pick.plan.miles} {u}{pick.plan.pace ? ` at ${secsToClock(pick.plan.pace)}/${u}` : ""}</span> : null}
                      {pick.plan.lift && pick.plan.kind !== "lift" && <span className="tag lift">+ {pick.plan.lift}</span>}
                      <button className="ghost" onClick={() => setEdit({ ...pick.plan })}>Edit</button>
                    </>
                  ) : (
                    <>
                      <span className="note">Nothing planned for this day.</span>
                      {pick.date >= today && <button className="ghost" onClick={() => setEdit({ date: pick.date, kind: "run", title: "Easy", miles: 5, note: "" })}>Add a session</button>}
                    </>
                  )}
                </div>
                {pick.plan?.note && <p className="note" style={{ color: "var(--ink)" }}>{pick.plan.note}</p>}
                <div className="divline" />
                <div className="grid4" style={{ gap: 12 }}>
                  <Stat v={pick.ran ? `${pick.ran} ${u}` : pick.lifted ? "lift" : pick.past ? "nothing" : "—"}
                        l={pick.past ? "what you did" : "logged so far"} color={pick.ran ? HEX.run : HEX.rest}
                        sub={pick.pace ? `${secsToClock(pick.pace)}/${u}` : ""} />
                  <Stat v={pick.sleep ?? null} l="slept" color={HEX.sleep} />
                  <Stat v={pick.rhr ?? null} l="resting HR" color={HEX.rhr} />
                  <Stat v={pick.drinks || pick.thc ? [pick.drinks ? `${pick.drinks} drinks` : null, pick.thc ? `${pick.thc} mg` : null].filter(Boolean).join(", ") : "clean"}
                        l="that day" color={pick.drinks > 4.5 || pick.thc > 5 ? HEX.alert : HEX.rest} />
                </div>
                {pick.note && <p className="note" style={{ marginTop: 10 }}>{pick.note}</p>}
              </>
            ) : (
              <>
                <div className="row">
                  <label className="f" style={{ width: 108 }}>Type
                    <select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}>
                      <option value="run">Run</option><option value="lift">Lift</option><option value="rest">Rest</option>
                    </select>
                  </label>
                  <label className="f" style={{ flex: 1, minWidth: 140 }}>Session
                    <input value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                  </label>
                  <label className="f" style={{ width: 90 }}>{u}
                    <input value={edit.miles ?? ""} inputMode="decimal" onChange={(e) => setEdit({ ...edit, miles: e.target.value === "" ? null : Number(e.target.value) })} />
                  </label>
                </div>
                <div className="row" style={{ marginTop: 10 }}>
                  <label className="f" style={{ flex: 1, minWidth: 180 }}>Lift as well <span style={{ color: "var(--faint)" }}>(leave blank for none)</span>
                    <input value={edit.lift ?? ""} placeholder="Push — upper" onChange={(e) => setEdit({ ...edit, lift: e.target.value || null })} />
                  </label>
                  <div className="chips" style={{ paddingBottom: 4 }}>
                    {["Push — upper", "Pull & legs", ""].map((x) => (
                      <button key={x || "none"} className="tchip" aria-pressed={(edit.lift || "") === x}
                              onClick={() => setEdit({ ...edit, lift: x || null })}>{x || "none"}</button>
                    ))}
                  </div>
                </div>
                <label className="f" style={{ marginTop: 10 }}>Note
                  <textarea rows={2} value={edit.note || ""} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
                </label>
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <button className="solid" onClick={() => {
                    if (byDate.has(edit.date)) updateDay(edit.date, edit); else addDay(edit);
                    setEdit(null); setPick(null);
                  }}>Save</button>
                  <button className="ghost" onClick={() => setEdit(null)}>Cancel</button>
                  {byDate.has(edit.date) && (
                    <button className="danger" onClick={() => { setPlanned((planned || []).filter((d) => d.date !== edit.date)); setEdit(null); setPick(null); }}>
                      Remove from plan
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}

/* The numbers worth chasing, over the whole log rather than the selected range. */
function Bests({ daily, sessions, doses, settings }) {
  const u = settings.distanceUnit;
  const today = toDayKey(new Date());

  const runs = sessions.filter((s) => s.kind === "run" && s.distanceKm);
  const longest = runs.reduce((a, r) => (r.distanceKm > (a?.distanceKm || 0) ? r : a), null);
  // fastest pace only counts runs of a sensible length, so a two-mile blast doesn't win everything
  const proper = runs.filter((r) => toUnit(r.distanceKm, u) >= 3 && paceSecOf(r, u));
  const fastest = proper.reduce((a, r) => (paceSecOf(r, u) < paceSecOf(a, u) ? r : a), proper[0] || null);

  const weeks = new Map();
  for (const r of runs) {
    const w = mondayOf(r.date);
    weeks.set(w, (weeks.get(w) || 0) + r.distanceKm);
  }
  const bigWeek = [...weeks.entries()].sort((a, b) => b[1] - a[1])[0] || null;

  const allDays = [...daily.byDay.keys()].sort();
  const from = allDays[0] || today;
  const span = [];
  for (let k = from; k <= today; k = addDays(k, 1)) span.push(k);

  const longestRun = (test) => {
    let best = 0, cur = 0, bestEnd = null;
    for (const k of span) { if (test(daily.get(k))) { cur++; if (cur > best) { best = cur; bestEnd = k; } } else cur = 0; }
    return { best, bestEnd };
  };
  const current = (test) => {
    let n = 0;
    for (let i = 0; i < span.length; i++) { const k = addDays(today, -i); if (!daily.byDay.has(k) && i > 0) break; if (test(daily.get(k))) n++; else if (i > 0) break; }
    return n;
  };
  const dry = longestRun((x) => !x.alc);
  const clean = longestRun((x) => !x.alc && !x.thc && !x.nic && !x.stim);
  const training = longestRun((x) => x.hasRun || x.hasLift);

  const bestSleepWeek = (() => {
    const wk = new Map();
    for (const k of span) { const sc = daily.get(k).sleep?.score; if (sc == null) continue; const w = mondayOf(k); if (!wk.has(w)) wk.set(w, []); wk.get(w).push(sc); }
    const rows = [...wk.entries()].filter(([, v]) => v.length >= 4).map(([w, v]) => [w, avg(v)]);
    return rows.sort((a, b) => b[1] - a[1])[0] || null;
  })();

  if (!runs.length && !allDays.length) return null;

  return (
    <div className="panel">
      <h2>Bests and streaks <span className="hint">across everything you have logged</span></h2>
      <div className="body">
        <div className="grid4" style={{ gap: 12 }}>
          <Stat v={longest ? round(toUnit(longest.distanceKm, u), 1) : null} l={`longest run (${u})`} color={HEX.run}
                sub={longest ? fmtShort(longest.date) : ""} />
          <Stat v={fastest ? secsToClock(paceSecOf(fastest, u)) : null} l={`fastest pace / ${u}`} color={HEX.run}
                sub={fastest ? `${round(toUnit(fastest.distanceKm, u), 1)} ${u} on ${fmtShort(fastest.date)}` : "runs of 3+ only"} />
          <Stat v={bigWeek ? round(toUnit(bigWeek[1], u), 1) : null} l={`biggest week (${u})`} color={HEX.run}
                sub={bigWeek ? `week of ${fmtShort(bigWeek[0])}` : ""} />
          <Stat v={bestSleepWeek ? Math.round(bestSleepWeek[1]) : null} l="best sleep week" color={HEX.sleep}
                sub={bestSleepWeek ? `week of ${fmtShort(bestSleepWeek[0])}` : "needs 4 nights in a week"} />
          <Stat v={training.best || null} l="longest training streak" color={HEX.lift}
                sub={`${current((x) => x.hasRun || x.hasLift)} running now`} />
          <Stat v={dry.best || null} l="longest dry streak" color={kindHex("alcohol")}
                sub={`${current((x) => !x.alc)} days now`} />
          <Stat v={clean.best || null} l="longest clean streak" color={HEX.lift}
                sub={`nothing logged at all · ${current((x) => !x.alc && !x.thc && !x.nic && !x.stim)} days now`} />
          <Stat v={span.length} l="days on record" color={HEX.rest}
                sub={from !== today ? `since ${fmtShort(from)}` : ""} />
        </div>
      </div>
    </div>
  );
}

/* Garmin's own read on aerobic fitness. Both update every few days rather than nightly,
   so the lines connect across the gaps. */
function AerobicCapacity({ daily, range }) {
  const today = toDayKey(new Date());
  const span = lastNDays(range, today);
  const rows = span.map((k) => {
    const sl = daily.get(k).sleep;
    return { k, label: fmtShort(k), vo2: sl?.vo2 ?? null, age: sl?.fitnessAge ?? null };
  });
  const vo2s = rows.filter((r) => r.vo2 != null);
  const ages = rows.filter((r) => r.age != null);
  if (!vo2s.length && !ages.length) return null;

  const first = vo2s[0]?.vo2, last = vo2s[vo2s.length - 1]?.vo2;
  const delta = first != null && last != null ? round(last - first, 1) : null;
  const best = vo2s.length ? Math.max(...vo2s.map((r) => r.vo2)) : null;

  return (
    <div className="panel">
      <h2>Aerobic capacity <span className="hint">from Garmin, updated after hard efforts</span></h2>
      <div className="body" style={{ paddingTop: 8 }}>
        <div className="grid4" style={{ gap: 12, marginBottom: 12 }}>
          <Stat v={last ?? null} l="VO₂ max now" color={HEX.run}
                sub={delta != null ? `${delta >= 0 ? "+" : ""}${delta} over the range` : `${vo2s.length} reading${vo2s.length === 1 ? "" : "s"}`} />
          <Stat v={best ?? null} l="best in range" color={HEX.run} />
          {ages.length > 0 && (
            <Stat v={ages[ages.length - 1].age} l="fitness age" color={HEX.lift}
                  sub={ages.length > 1 ? `${round(ages[ages.length - 1].age - ages[0].age, 1)} over the range` : ""} />
          )}
          <Stat v={vo2s.length} l="readings in range" color={HEX.rest} />
        </div>
        <Chart h={190}>
          <ComposedChart data={rows} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid stroke={HEX.grid} vertical={false} />
            <XAxis dataKey="label" tick={axisTick()} interval={tickGap(rows.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
            <YAxis yAxisId="v" domain={["dataMin - 2", "dataMax + 2"]} tick={axisTick()} tickLine={false} axisLine={false} />
            {ages.length > 0 && (
              <YAxis yAxisId="a" orientation="right" domain={["dataMin - 2", "dataMax + 2"]} tick={axisTick()} tickLine={false} axisLine={false} />
            )}
            <Tooltip content={<Tip />} />
            <Line yAxisId="v" type="monotone" dataKey="vo2" name="VO₂ max" stroke={HEX.run} strokeWidth={2.4} dot={{ r: 2.5 }} connectNulls />
            {ages.length > 0 && (
              <Line yAxisId="a" type="monotone" dataKey="age" name="Fitness age" stroke={HEX.lift} strokeWidth={1.8}
                    strokeDasharray="6 3" dot={false} connectNulls />
            )}
          </ComposedChart>
        </Chart>
        <div className="legend">
          <span><i style={{ background: HEX.run }} />VO₂ max (left), higher is fitter</span>
          {ages.length > 0 && <span><i style={{ background: HEX.lift }} />fitness age (right), lower is fitter</span>}
          <span>flat stretches are gaps between readings, not plateaus</span>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Intake                                                             */
/* ================================================================== */

function IntakeDash({ doses, sleep, sessions, days, settings, range }) {
  const daily = useDaily({ doses, sleep, sessions, days, settings });
  const today = toDayKey(new Date());
  const span = lastNDays(range, today);
  const buckets = bucketize(span, range);
  const noun = bucketNoun(range);

  // one cluster per bucket: coffees as a count, drinks as standard drinks, the rest in mg
  const chart = buckets.map((b) => ({
    label: b.label,
    coffees: bucketSum(b, (k) => daily.get(k).cafCount),
    drinks: round(bucketSum(b, (k) => daily.get(k).alc), 1),
    edibles: round(bucketSum(b, (k) => daily.get(k).thcMg), 1),
    zyns: round(bucketSum(b, (k) => daily.get(k).nicMg), 1),
    addy: round(bucketSum(b, (k) => daily.get(k).stimMg), 1),
  }));

  const tot = (f) => sum(span.map((k) => f(daily.get(k)) || 0));
  const usedDays = (f) => span.filter((k) => f(daily.get(k)) > 0).length;
  const longestClean = (f) => {
    let best = 0, cur = 0;
    for (const k of span) { if (f(daily.get(k)) > 0) { best = Math.max(best, cur); cur = 0; } else cur++; }
    return Math.max(best, cur);
  };
  const thisWeek = lastNDays(7, today).filter((k) => k >= mondayOf(today));
  const wkDrinks = sum(thisWeek.map((k) => daily.get(k).alc));
  const overCaf = span.filter((k) => daily.get(k).caf > settings.caffeineLimitMg).length;
  const heavy = span.filter((k) => { const x = daily.get(k); return x.alc > 4.5 || x.thcMg > 5; }).length;
  const clean = span.filter((k) => { const x = daily.get(k); return !x.caf && !x.alc && !x.thc && !x.nic && !x.stim; }).length;
  const weeks = Math.max(1, range / 7);

  const recent = [...doses].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 20);
  const C = { coffees: kindHex("caffeine"), drinks: kindHex("alcohol"), edibles: kindHex("cannabis"), zyns: kindHex("nicotine"), addy: kindHex("stimulant") };
  const tipFmt = (p) => (p.dataKey === "coffees" ? `${p.value} coffee${p.value === 1 ? "" : "s"}` : p.dataKey === "drinks" ? `${p.value} drinks` : `${p.value} mg`);

  return (
    <>
      <ScorePanel which="degen" daily={daily} settings={settings} range={range} />
      <ScoreRidges which="degen" daily={daily} settings={settings} range={range} />
      <div className="panel">
        <h2>Intake <span className="hint">last {range} days</span></h2>
        <div className="body">
          <div className="grid4" style={{ gap: 12 }}>
            <Stat v={round(tot((x) => x.cafCount) / weeks, 1)} l="coffees / week" color={C.coffees}
                  sub={overCaf ? `${overCaf} day${overCaf === 1 ? "" : "s"} over ${settings.caffeineLimitMg} mg` : `never over ${settings.caffeineLimitMg} mg`} />
            <Stat v={round(tot((x) => x.alc) / weeks, 1)} l="drinks / week" color={C.drinks}
                  sub={`${usedDays((x) => x.alc)} drinking days · ${round(wkDrinks, 1)} of ${settings.drinksWeeklyLimit} this week`}
                  bar={{ pct: (wkDrinks / settings.drinksWeeklyLimit) * 100, color: wkDrinks > settings.drinksWeeklyLimit ? HEX.alert : C.drinks }} />
            <Stat v={round(tot((x) => x.thcMg) / weeks, 1)} l="mg THC / week" color={C.edibles}
                  sub={`${usedDays((x) => x.thc)} days · ${daysSince(doses, "cannabis") ?? "—"}d since last · longest break ${longestClean((x) => x.thc)}d`} />
            <Stat v={round(tot((x) => x.nicMg) / weeks, 1)} l="mg nicotine / week" color={C.zyns}
                  sub={`${usedDays((x) => x.nic)} days · ${daysSince(doses, "nicotine") ?? "—"}d since last · longest break ${longestClean((x) => x.nic)}d`} />
            <Stat v={round(tot((x) => x.stimMg) / weeks, 1)} l="mg adderall / week" color={C.addy}
                  sub={`${usedDays((x) => x.stim)} days · ${daysSince(doses, "stimulant") ?? "—"}d since last`} />
            <Stat v={heavy} l="heavy days" color={HEX.alert}
                  sub="more than 4.5 drinks or more than 5 mg THC" />
            <Stat v={clean} l="days with nothing logged" color={HEX.lift}
                  sub={`${Math.round((clean / span.length) * 100)}% of the range`} />
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Everything, side by side <span className="hint">per {noun}; coffees and drinks on the left, mg on the right</span></h2>
        <div className="body" style={{ paddingTop: 8 }}>
          <Chart h={240}>
            <BarChart data={chart} margin={{ top: 6, right: 8, left: -18, bottom: 0 }} barCategoryGap="22%" barGap={1}>
              <CartesianGrid stroke={HEX.grid} vertical={false} />
              <XAxis dataKey="label" tick={axisTick()} interval={tickGap(chart.length)} tickLine={false} axisLine={{ stroke: HEX.rule }} />
              <YAxis yAxisId="count" tick={axisTick()} tickLine={false} axisLine={false} allowDecimals={false} />
              <YAxis yAxisId="mg" orientation="right" tick={axisTick()} tickLine={false} axisLine={false} />
              <Tooltip content={<Tip fmt={tipFmt} />} />
              <Bar yAxisId="count" dataKey="coffees" name="Coffees" fill={C.coffees} radius={[2, 2, 0, 0]} />
              <Bar yAxisId="count" dataKey="drinks" name="Drinks" fill={C.drinks} radius={[2, 2, 0, 0]} />
              <Bar yAxisId="mg" dataKey="edibles" name="THC mg" fill={C.edibles} radius={[2, 2, 0, 0]} />
              <Bar yAxisId="mg" dataKey="zyns" name="Nicotine mg" fill={C.zyns} radius={[2, 2, 0, 0]} />
              <Bar yAxisId="mg" dataKey="addy" name="Adderall mg" fill={C.addy} radius={[2, 2, 0, 0]} />
            </BarChart>
          </Chart>
          <div className="legend">
            <span><i style={{ background: C.coffees }} />coffees (count)</span>
            <span><i style={{ background: C.drinks }} />drinks</span>
            <span><i style={{ background: C.edibles }} />THC mg</span>
            <span><i style={{ background: C.zyns }} />nicotine mg</span>
            <span><i style={{ background: C.addy }} />adderall mg</span>
          </div>
        </div>
      </div>

      <div className="panel">
        <h2>Recent entries</h2>
        <div className="body">
          {recent.length ? (
            <table>
              <thead><tr><th>When</th><th>What</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {recent.map((d) => (
                  <tr key={d.id}>
                    <td style={{ whiteSpace: "nowrap", color: "var(--soft)" }}>{fmtShort(dayKeyFor(d.ts, settings.dayStartHour))} {fmtClock(d.ts)}</td>
                    <td><span style={{ color: KIND_META[d.kind]?.color, marginRight: 6 }}>●</span>{d.label}</td>
                    <td className="num">{d.amount} {d.unit}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="empty">Nothing logged yet.</p>}
        </div>
      </div>
    </>
  );
}

/* ================================================================== */
/* Data                                                               */
/* ================================================================== */

function Data({ state, setSleep, setSessions, setLifts, setDoses, setDays, setSpend, settings, setSettings, resetAll, storageOk }) {
  const [source, setSource] = useState("garmin");
  const [text, setText] = useState("");
  const [msg, setMsg] = useState(null);
  const csvRef = useRef(null);
  const jsonRef = useRef(null);

  const ingest = (csv) => {
    setMsg(null);
    const parsed = Papa.parse(csv.trim(), { header: true, skipEmptyLines: true });
    if (!parsed.data?.length) { setMsg({ bad: true, text: "No rows read. The first line needs to be a header row." }); return; }
    const headers = parsed.meta.fields || Object.keys(parsed.data[0]);
    try {
      if (source === "garmin") {
        const recs = parseGarminSleep(parsed.data, headers);
        if (!recs.length) throw new Error("No dated sleep rows found. The file needs a date column.");
        const merged = mergeBy(state.sleep, recs, (r) => r.date);
        setSleep(merged); setMsg({ text: `${recs.length} nights read, ${merged.length} on file.` });
      } else if (source === "strava" || source === "garminact") {
        const recs = source === "strava" ? parseStravaActivities(parsed.data, headers) : parseGarminActivities(parsed.data, headers, settings.distanceUnit);
        if (!recs.length) throw new Error(source === "strava" ? "No runs found. Use activities.csv from the Strava bulk export." : "No runs found in that file. Check that the export includes running activities.");
        // The import wins on a day you also typed a run, but your type and note carry over.
        const importedDays = new Set(recs.map((r) => r.date));
        const manualRuns = state.sessions.filter((s) => s.kind === "run" && s.source === "manual" && importedDays.has(s.date));
        const kept = state.sessions.filter((s) => !manualRuns.includes(s));
        const enriched = recs.map((r) => {
          const m = manualRuns.find((s) => s.date === r.date);
          return m ? { ...r, type: m.type || r.type, note: m.note || r.note } : r;
        });
        const merged = mergeBy(kept, enriched, (r) => r.id);
        setSessions(merged); setMsg({ text: `${recs.length} runs read, ${manualRuns.length} hand-typed run${manualRuns.length === 1 ? "" : "s"} replaced.` });
      } else {
        const recs = parseStrongCsv(parsed.data, headers);
        if (!recs.length) throw new Error("No sets found. Strong's export needs Date, Exercise Name, Weight and Reps.");
        const merged = mergeBy(state.lifts, recs, (r) => `${r.date}|${r.exercise}|${r.weight}|${r.reps}|${r.workout}`);
        setLifts(merged); setMsg({ text: `${recs.length} sets read, ${merged.length} on file.` });
      }
      setText("");
    } catch (e) { setMsg({ bad: true, text: e.message }); }
  };

  const onCsv = (ev) => {
    const f = ev.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => ingest(String(r.result));
    r.onerror = () => setMsg({ bad: true, text: "Could not read that file." });
    r.readAsText(f); ev.target.value = "";
  };

  const onJson = (ev) => {
    const f = ev.target.files?.[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(String(r.result));
        if (d.doses) setDoses(d.doses);
        if (d.sleep) setSleep(d.sleep);
        if (d.sessions) setSessions(d.sessions);
        if (d.lifts) setLifts(d.lifts);
        if (d.days) setDays(d.days);
        if (d.spend) setSpend(d.spend);
        if (d.settings) setSettings(withDefaults(d.settings));
        setMsg({ text: "Backup restored." });
      } catch { setMsg({ bad: true, text: "That file is not a valid backup." }); }
    };
    r.readAsText(f); ev.target.value = "";
  };

  const download = (content, name, type) => {
    const blob = new Blob([content], { type });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = name; a.click(); URL.revokeObjectURL(a.href);
  };
  const exportJson = () => download(JSON.stringify(state, null, 2), `health-log-${toDayKey(new Date())}.json`, "application/json");
  const exportCsv = () => {
    // one row per day: the same shape as the Log tab
    const keys = new Set([...state.sleep.map((s) => s.date), ...state.sessions.map((s) => s.date), ...state.days.map((d) => d.date),
      ...state.doses.map((d) => dayKeyFor(d.ts, settings.dayStartHour)), ...(state.spend || []).map((t) => t.date)]);
    const rows = [...keys].sort().map((k) => {
      const sl = state.sleep.find((s) => s.date === k);
      const ses = state.sessions.filter((s) => s.date === k);
      const ds = state.doses.filter((d) => dayKeyFor(d.ts, settings.dayStartHour) === k);
      const dy = state.days.find((d) => d.date === k);
      const sp = (state.spend || []).filter((t) => t.date === k && t.amount > 0);
      const kindSum = (kind) => ds.filter((d) => d.kind === kind).reduce((a, b) => a + b.amount, 0);
      const runPaces = ses.filter((s) => s.kind === "run").map((s) => paceSecOf(s, settings.distanceUnit)).filter(Boolean);
      return {
        date: k, sleep_score: sl?.score ?? "", hours_asleep: sl?.asleepMin != null ? round(sl.asleepMin / 60, 2) : "", resting_hr: sl?.restingHr ?? "",
        body_battery: sl?.bodyBattery ?? "", bedtime: sl?.bedtime ?? "",
        vo2_max: sl?.vo2 ?? "", fitness_age: sl?.fitnessAge ?? "",
        day_tags: (dy?.tags || []).join(" | "), day_note: dy?.note ?? "", steps: dy?.steps ?? "",
        spend_out: round(sum(sp.filter((t) => t.bucket === "out").map((t) => t.amount)), 2) || "",
        spend_total: round(sum(sp.map((t) => t.amount)), 2) || "",
        workouts: ses.map((s) => `${s.kind}:${s.type || ""}`).join(" | "),
        run_distance: round(toUnit(sum(ses.filter((s) => s.kind === "run").map((s) => s.distanceKm || 0)), settings.distanceUnit), 2) || "",
        run_pace: runPaces.length ? secsToClock(avg(runPaces)) : "",
        caffeine_mg: Math.round(kindSum("caffeine")), drinks: round(kindSum("alcohol"), 1) ?? 0,
        cannabis_entries: ds.filter((d) => d.kind === "cannabis").length, nicotine_entries: ds.filter((d) => d.kind === "nicotine").length,
        workout_notes: ses.map((s) => s.note).filter(Boolean).join(" | "),
      };
    });
    download(Papa.unparse(rows), `health-log-days-${toDayKey(new Date())}.csv`, "text/csv");
  };

  const hints = {
    garmin: "Garmin has no sleep CSV of its own, so use the converter built for this: drop the sleepData.json files from your Garmin export into it and import the CSV it writes. Score, duration, resting HR, body battery, bedtime, VO₂ max and fitness age are all read if present.",
    garminact: `Garmin Connect on the web: Activities, All Activities, then Export CSV at the top right. Only runs are read. Distance is taken in ${settings.distanceUnit}, matching your Garmin display unit; switch the unit above first if yours differs.`,
    strava: "Strava on the web: Settings, My Account, Download or Delete Your Account, request the archive. Use activities.csv when it arrives. Slow, but complete.",
    strong: "Strong app: Settings, Export Data. It emails you a CSV of every set. Sets roll up into one lift session per workout.",
  };

  return (
    <>
      {!storageOk && (
        <div className="panel" style={{ borderColor: "var(--alert)" }}>
          <h2 style={{ color: "var(--alert)" }}>Not saving</h2>
          <div className="body">
            <p className="note">
              The app could not write to the database, so nothing you log will stick until this clears.
              {store.lastError ? <><br /><b style={{ color: "var(--alert)" }}>Reason: {store.lastError}</b></> : ""}
              <br />Usually the fix is re-running supabase.sql in the Supabase SQL Editor (SETUP.md step 3.4), or re-copying the two codes into config.js (step 4).
            </p>
          </div>
        </div>
      )}

      <div className="panel">
        <h2>Bring in data</h2>
        <div className="body">
          <div className="row" style={{ marginBottom: 10 }}>
            <label className="f" style={{ width: 218 }}>Source
              <select value={source} onChange={(e) => { setSource(e.target.value); setMsg(null); }}>
                <option value="garmin">Garmin sleep</option>
                <option value="garminact">Garmin activities (runs)</option>
                <option value="strava">Strava activities (runs)</option>
                <option value="strong">Strong (lifting)</option>
              </select>
            </label>
            <button className="ghost" onClick={() => csvRef.current?.click()}>Choose CSV file</button>
            <input ref={csvRef} type="file" accept=".csv,text/csv" onChange={onCsv} style={{ display: "none" }} />
          </div>
          <p className="note" style={{ marginBottom: 10 }}>{hints[source]}</p>
          <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)}
                    placeholder="…or paste the CSV contents here, header row included" />
          <div style={{ marginTop: 9, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button className="solid" onClick={() => text.trim() && ingest(text)}>Import</button>
            {msg && <span className="note" style={{ color: msg.bad ? "var(--alert)" : "var(--lift)" }}>{msg.text}</span>}
          </div>
          <div className="divline" />
          <p className="note">
            Column names are matched loosely, so exports from different app versions still land.
            Re-importing the same file updates rows rather than duplicating them.
            On file: {state.sleep.length} nights, {state.sessions.length} sessions, {state.lifts.length} sets,
            {" "}{state.doses.length} intake entries, {state.days.length} day notes, {(state.spend || []).length} transactions.
          </p>
        </div>
      </div>

      <StravaPanel />

      <NotesImport doses={state.doses} setDoses={setDoses} days={state.days} setDays={setDays} settings={settings} />

      <div className="panel">
        <h2>Targets and units</h2>
        <div className="body">
          <div className="row">
            <label className="f" style={{ width: 118 }}>Distance
              <select value={settings.distanceUnit} onChange={(e) => setSettings({ ...settings, distanceUnit: e.target.value })}>
                <option value="mi">miles</option><option value="km">kilometres</option>
              </select>
            </label>
            <label className="f" style={{ width: 96 }}>Weight
              <select value={settings.weightUnit} onChange={(e) => setSettings({ ...settings, weightUnit: e.target.value })}>
                <option value="lb">lb</option><option value="kg">kg</option>
              </select>
            </label>
            <label className="f" style={{ width: 130 }}>Sleep score goal
              <input value={settings.sleepScoreGoal} inputMode="numeric"
                     onChange={(e) => setSettings({ ...settings, sleepScoreGoal: Number(e.target.value) || 80 })} />
            </label>
            <label className="f" style={{ width: 130 }}>Sleep hours goal
              <input value={settings.sleepHoursGoal} inputMode="decimal"
                     onChange={(e) => setSettings({ ...settings, sleepHoursGoal: Number(e.target.value) || 7.5 })} />
            </label>
            <label className="f" style={{ width: 128 }}>Caffeine limit (mg)
              <input value={settings.caffeineLimitMg} inputMode="numeric"
                     onChange={(e) => setSettings({ ...settings, caffeineLimitMg: Number(e.target.value) || 400 })} />
            </label>
            <label className="f" style={{ width: 136 }}>Drinks per week limit
              <input value={settings.drinksWeeklyLimit} inputMode="numeric"
                     onChange={(e) => setSettings({ ...settings, drinksWeeklyLimit: Number(e.target.value) || 7 })} />
            </label>
            <label className="f" style={{ width: 176 }}>Peer payment counts as going out under
              <input value={settings.peerSocialMax ?? 150} inputMode="numeric"
                     onChange={(e) => setSettings({ ...settings, peerSocialMax: Number(e.target.value) || 150 })} />
            </label>
            <label className="f" style={{ width: 118 }}>Steps goal
              <input value={settings.stepsGoal} inputMode="numeric"
                     onChange={(e) => setSettings({ ...settings, stepsGoal: Number(e.target.value) || 8000 })} />
            </label>
            <label className="f" style={{ width: 128 }}>Day starts at (24h)
              <input value={settings.dayStartHour} inputMode="numeric"
                     onChange={(e) => setSettings({ ...settings, dayStartHour: Number(e.target.value) || 4 })} />
            </label>
          </div>
          <p className="note" style={{ marginTop: 8 }}>
            "Day starts at" decides which day a 1am drink belongs to. With 4, anything before 4am counts toward the day before.
          </p>
        </div>
      </div>

      <TagEditor settings={settings} setSettings={setSettings} />
      <PresetEditor settings={settings} setSettings={setSettings} />

      <div className="panel">
        <h2>Backup and export</h2>
        <div className="body" style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <button className="ghost" onClick={exportCsv}>Download one row per day (CSV)</button>
          <button className="ghost" onClick={exportJson}>Download everything (JSON)</button>
          <button className="ghost" onClick={() => jsonRef.current?.click()}>Restore from backup</button>
          <input ref={jsonRef} type="file" accept=".json,application/json" onChange={onJson} style={{ display: "none" }} />
          <button className="danger" onClick={() => { if (confirm("Delete all logged data? This cannot be undone.")) resetAll(); }}>
            Erase all data
          </button>
        </div>
      </div>
    </>
  );
}

function NotesImport({ doses, setDoses, days, setDays, settings }) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(null);
  const [withNotes, setWithNotes] = useState(true);
  const [done, setDone] = useState(null);

  const look = () => {
    setDone(null);
    const r = parseNotes(text, toDayKey(new Date()));
    if (!r.entries.length) { setPreview({ ...r, empty: true }); return; }
    const have = new Set(doses.map((d) => d.id));
    const fresh = r.entries.filter((e) => !have.has(e.id));
    const byKind = KIND_ORDER.map((k) => ({ kind: k, n: fresh.filter((e) => e.kind === k).length })).filter((x) => x.n);
    const dates = [...new Set(r.entries.map((e) => e.ts.slice(0, 10)))].sort();
    setPreview({ ...r, fresh, byKind, dates, already: r.entries.length - fresh.length });
  };

  const bring = () => {
    const incoming = preview.fresh.map(({ flagged, ...e }) => e);
    setDoses(mergeBy(doses, incoming, (d) => d.id));
    let noteCount = 0;
    if (withNotes && preview.dayNotes.length) {
      const add = preview.dayNotes.filter((n) => !days.find((d) => d.date === n.date)?.note);
      noteCount = add.length;
      setDays(add.reduce((acc, n) => mergeBy(acc, [{ date: n.date, note: n.note }], (d) => d.date), days));
    }
    setDone({ n: incoming.length, notes: noteCount });
    setPreview(null); setText("");
  };

  return (
    <div className="panel">
      <h2>Import your notes <span className="hint">paste the whole file; anything already in is skipped</span></h2>
      <div className="body">
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)}
                  placeholder={"6/15:\n-1 espresso\n-1 zyn (6mg)\n-2 offfields (3mg)"} />
        <div style={{ marginTop: 9, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button className="solid" onClick={look} disabled={!text.trim()}>Read it</button>
          {done && <span className="note ok">Added {done.n} entr{done.n === 1 ? "y" : "ies"}{done.notes ? ` and ${done.notes} day note${done.notes === 1 ? "" : "s"}` : ""}.</span>}
        </div>

        {preview && preview.empty && <p className="note flag" style={{ marginTop: 10 }}>Nothing read. Dates need to look like <span className="pill">6/15:</span> with items under them starting with a dash.</p>}

        {preview && !preview.empty && (
          <>
            <div className="divline" />
            <p className="note" style={{ marginBottom: 8 }}>
              <b>{preview.fresh.length} new</b> from {preview.dates.length} days, {preview.dates[0]} to {preview.dates[preview.dates.length - 1]}.
              {preview.already ? ` ${preview.already} already in the log.` : ""}
            </p>
            <div className="chips" style={{ marginBottom: 10 }}>
              {preview.byKind.map((k) => (
                <span key={k.kind} className={`chip ${k.kind}`} style={{ cursor: "default" }}>
                  <i className="dot" /><span className="lbl">{KIND_META[k.kind].name}</span><span className="amt">{k.n}</span>
                </span>
              ))}
            </div>
            {preview.fresh.some((e) => e.flagged) && (
              <div style={{ marginBottom: 10 }}>
                <p className="note" style={{ marginBottom: 4 }}>
                  Estimated, because the note did not say exactly. Import anyway and correct them on the Log tab:
                </p>
                <table>
                  <tbody>
                    {preview.fresh.filter((e) => e.flagged).slice(0, 12).map((e) => (
                      <tr key={e.id}>
                        <td style={{ width: 86, color: "var(--soft)" }}>{fmtShort(e.ts.slice(0, 10))}</td>
                        <td>{e.label}</td>
                        <td className="num">{e.amount} {e.unit}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {preview.unread.length > 0 && (
              <p className="note flag" style={{ marginBottom: 10 }}>
                Skipped {preview.unread.length} line{preview.unread.length === 1 ? "" : "s"} it could not read:
                {" "}{preview.unread.slice(0, 5).map((u) => u.text).join(" · ")}{preview.unread.length > 5 ? " …" : ""}
              </p>
            )}
            <label className="note" style={{ display: "flex", gap: 7, alignItems: "center", marginBottom: 10 }}>
              <input type="checkbox" checked={withNotes} onChange={(e) => setWithNotes(e.target.checked)} style={{ width: "auto" }} />
              Also use the text after each date as that day's note ({preview.dayNotes.length} found)
            </label>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="solid" onClick={bring} disabled={!preview.fresh.length}>Import {preview.fresh.length} entries</button>
              <button className="ghost" onClick={() => setPreview(null)}>Cancel</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function StravaPanel() {
  const [status, setStatus] = useState("checking");   // checking | off | linked
  const [auto, setAuto] = useState(null);             // null = unknown, true/false once checked
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState("");

  const call = async (path) => {
    const { data } = await supabase.auth.getSession();
    const r = await fetch(path, { headers: { Authorization: `Bearer ${data.session?.access_token ?? ""}` } });
    const j = await r.json().catch(() => ({ error: "The server function did not reply. Is the latest version deployed?" }));
    if (!r.ok || j.error) throw new Error(j.error || `Request failed (${r.status})`);
    return j;
  };

  useEffect(() => {
    (async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u?.user) return;
      const { data } = await supabase.from("strava_tokens").select("athlete_id").eq("user_id", u.user.id).maybeSingle();
      setStatus(data ? "linked" : "off");
      if (data) call("/.netlify/functions/strava-subscribe?action=status").then((j) => setAuto(!!j.active)).catch(() => setAuto(null));
    })();
    const p = new URLSearchParams(window.location.search);
    if (p.get("strava")) {
      setMsg({ bad: p.get("strava") !== "connected", text: p.get("msg") || "" });
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  const run = async (label, path, after) => {
    setBusy(label); setMsg(null);
    try { const j = await call(path); setMsg({ text: j.message || "Done." }); after?.(j); }
    catch (e) { setMsg({ bad: true, text: String(e.message || e) }); }
    finally { setBusy(""); }
  };

  const connect = () => run("connect", "/.netlify/functions/strava-auth", (j) => { window.location.href = j.url; });
  const disconnect = async () => {
    if (!confirm("Disconnect Strava? Runs already logged stay where they are.")) return;
    const { data: u } = await supabase.auth.getUser();
    await supabase.from("strava_tokens").delete().eq("user_id", u.user.id);
    try { await call("/.netlify/functions/strava-subscribe?action=off"); } catch { /* subscription may already be gone */ }
    setStatus("off"); setAuto(null); setMsg({ text: "Strava disconnected." });
  };

  return (
    <div className="panel">
      <h2>Strava <span className="hint">{status === "linked" ? (auto ? "connected, syncing automatically" : "connected") : status === "off" ? "not connected" : ""}</span></h2>
      <div className="body">
        {status === "off" && (
          <>
            <p className="note" style={{ marginBottom: 10 }}>
              Your watch already sends runs to Strava. Connect it here and they land in this log by themselves.
            </p>
            <button className="solid" onClick={connect} disabled={busy === "connect"}>
              {busy === "connect" ? "Opening Strava…" : "Connect Strava"}
            </button>
          </>
        )}
        {status === "linked" && (
          <>
            <div className="row" style={{ gap: 10 }}>
              <button className="solid" onClick={() => run("sync", "/.netlify/functions/strava-sync?days=30", () => setTimeout(() => window.location.reload(), 1500))} disabled={!!busy}>
                {busy === "sync" ? "Pulling…" : "Pull the last 30 days"}
              </button>
              <button className="ghost" onClick={() => { if (confirm("Pull every run Strava has? This can take a minute.")) run("all", "/.netlify/functions/strava-sync?days=7300", () => setTimeout(() => window.location.reload(), 2500)); }} disabled={!!busy}>
                {busy === "all" ? "Pulling your whole history…" : "Pull everything"}
              </button>
              {auto ? (
                <button className="ghost" onClick={() => run("auto", "/.netlify/functions/strava-subscribe?action=off", () => setAuto(false))} disabled={!!busy}>Turn automatic sync off</button>
              ) : (
                <button className="ghost" onClick={() => run("auto", "/.netlify/functions/strava-subscribe?action=on", () => setAuto(true))} disabled={!!busy}>
                  {busy === "auto" ? "Setting up…" : "Turn automatic sync on"}
                </button>
              )}
              <button className="ghost" onClick={disconnect} disabled={!!busy}>Disconnect</button>
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              {auto
                ? "New runs appear about a minute after they reach Strava. Pull the last 30 days if one ever goes missing."
                : "Automatic sync is off, so runs only arrive when you pull them."}
              {" "}A Strava run replaces a run you typed by hand on the same day, keeping your type and note.
            </p>
          </>
        )}
        {msg && <p className="note" style={{ marginTop: 10, color: msg.bad ? "var(--alert)" : "var(--lift)" }}>{msg.text}</p>}
      </div>
    </div>
  );
}

function TagEditor({ settings, setSettings }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim().toLowerCase();
    if (!t || settings.dayTags.includes(t)) { setDraft(""); return; }
    setSettings({ ...settings, dayTags: [...settings.dayTags, t] }); setDraft("");
  };
  const remove = (t) => setSettings({ ...settings, dayTags: settings.dayTags.filter((x) => x !== t) });
  return (
    <div className="panel">
      <h2>Day tags <span className="hint">the kinds of day you want to be able to compare</span></h2>
      <div className="body">
        <div className="chips" style={{ marginBottom: 10 }}>
          {settings.dayTags.map((t) => (
            <span key={t} className="chip" style={{ cursor: "default", color: "var(--sleep)" }}>
              <span className="lbl">{t}</span>
              <button className="del" onClick={() => remove(t)} title="Remove">×</button>
            </span>
          ))}
        </div>
        <div className="row">
          <label className="f" style={{ flex: 1, minWidth: 160 }}>New tag
            <input value={draft} placeholder="hungover, wfh, race week" onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} />
          </label>
          <button className="solid" onClick={add}>Add tag</button>
        </div>
        <p className="note" style={{ marginTop: 8 }}>Removing a tag hides the chip; days already tagged keep it.</p>
      </div>
    </div>
  );
}

function PresetEditor({ settings, setSettings }) {
  const [label, setLabel] = useState(""); const [amt, setAmt] = useState("");
  const [kind, setKind] = useState("caffeine"); const [unit, setUnit] = useState("mg");
  const [ask, setAsk] = useState(false);

  const add = () => {
    if (!label.trim() || !Number(amt)) return;
    setSettings({ ...settings, presets: [...settings.presets, { id: uid(), kind, label: label.trim(), amount: Number(amt), unit, ask: ask && unit === "mg" }] });
    setLabel(""); setAmt(""); setAsk(false);
  };
  const toggleAsk = (id) => setSettings({ ...settings, presets: settings.presets.map((p) => (p.id === id ? { ...p, ask: !p.ask } : p)) });
  const remove = (id) => setSettings({ ...settings, presets: settings.presets.filter((p) => p.id !== id) });
  const move = (id, dir) => {
    const ps = [...settings.presets]; const i = ps.findIndex((p) => p.id === id); const j = i + dir;
    if (i < 0 || j < 0 || j >= ps.length) return;
    [ps[i], ps[j]] = [ps[j], ps[i]];
    setSettings({ ...settings, presets: ps });
  };

  return (
    <div className="panel">
      <h2>Quick-log chips <span className="hint">what shows on the Log tab</span></h2>
      <div className="body">
        {KIND_ORDER.map((k) => {
          const ps = settings.presets.filter((p) => p.kind === k);
          if (!ps.length) return null;
          return (
            <div key={k} style={{ marginBottom: 10 }}>
              <div className="note" style={{ marginBottom: 5, color: KIND_META[k].color }}>{KIND_META[k].name}</div>
              <div className="chips">
                {ps.map((p) => (
                  <span key={p.id} className={`chip ${p.kind}`} style={{ cursor: "default" }}>
                    <i className="dot" /><span className="lbl">{p.label}</span>
                    <span className="amt">{p.ask ? `mg? (${p.amount} default)` : `${p.amount}${p.unit === "mg" ? "mg" : ` ${p.unit}`}`}</span>
                    {p.unit === "mg" && <button className="del" onClick={() => toggleAsk(p.id)} title={p.ask ? "Log a fixed amount instead" : "Ask for the amount each time"} style={{ fontSize: 11 }}>{p.ask ? "fix" : "ask"}</button>}
                    <button className="del" onClick={() => move(p.id, -1)} title="Move left">‹</button>
                    <button className="del" onClick={() => move(p.id, 1)} title="Move right">›</button>
                    <button className="del" onClick={() => remove(p.id)} title="Remove">×</button>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        <div className="row">
          <label className="f" style={{ width: 118 }}>Type
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KIND_ORDER.map((k) => <option key={k} value={k}>{KIND_META[k].name}</option>)}
            </select>
          </label>
          <label className="f" style={{ flex: 1, minWidth: 130 }}>Label<input value={label} placeholder="Nitro cold brew" onChange={(e) => setLabel(e.target.value)} /></label>
          <label className="f" style={{ width: 88 }}>Amount<input value={amt} inputMode="decimal" onChange={(e) => setAmt(e.target.value)} /></label>
          <label className="f" style={{ width: 106 }}>Unit
            <select value={unit} onChange={(e) => setUnit(e.target.value)}>
              <option value="mg">mg</option><option value="drinks">drinks</option>
              <option value="hits">hits</option><option value="sessions">sessions</option>
            </select>
          </label>
          <label className="f" style={{ width: 132, flexDirection: "row", alignItems: "center", gap: 6, paddingBottom: 7 }}>
            <input type="checkbox" checked={ask} disabled={unit !== "mg"} onChange={(e) => setAsk(e.target.checked)} style={{ width: "auto" }} />
            ask mg each time
          </label>
          <button className="solid" onClick={add}>Add chip</button>
        </div>
        <p className="note" style={{ marginTop: 8 }}>Chips marked "mg?" open a small box for the amount when tapped; the number shown is only the placeholder.</p>
      </div>
    </div>
  );
}

/* ================================================================== */
/* app                                                                */
/* ================================================================== */

function withDefaults(st) {
  const s = { ...DEFAULT_SETTINGS, ...(st || {}), race: { ...DEFAULT_SETTINGS.race, ...((st && st.race) || {}) } };
  if (!Array.isArray(s.dayTags)) s.dayTags = DEFAULT_SETTINGS.dayTags;
  if (!PALETTES[s.theme]) s.theme = "light";
  if (!RACE_TYPES[s.race.kind]) s.race.kind = "marathon";
  s.priorRace = { distanceMi: 26.2, time: "", date: "", ...(s.priorRace || {}) };
  if (s.planStart === undefined) s.planStart = null;
  if (!Array.isArray(s.planAdjust)) s.planAdjust = [];
  if (!Array.isArray(s.races)) s.races = [];
  // races saved before statuses existed were all ones he had entered
  s.races = s.races.map((r) => (r.status ? r : { ...r, status: "entered" }));
  if (!Array.isArray(s.planSwaps)) s.planSwaps = [];
  s.planPrefs = { ...DEFAULT_PREFS, ...(s.planPrefs || {}) };
  if (!Array.isArray(s.planPrefs.longRunDays) || !s.planPrefs.longRunDays.length) s.planPrefs.longRunDays = DEFAULT_PREFS.longRunDays;
  if (!Array.isArray(s.presets) || !s.presets.length) s.presets = DEFAULT_SETTINGS.presets;
  else {
    // bring saved chips in line with the current defaults without touching ones you added yourself
    s.presets = s.presets
      .filter((p) => !["c5", "w6", "w2"].includes(p.id))
      .map((p) => (p.id === "w1" ? { ...p, label: "Edible", amount: p.amount || 10, ask: true }
        : p.id === "n1" ? { ...p, ask: true } : p));
    if (!s.presets.some((p) => p.kind === "stimulant")) {
      s.presets = [...s.presets, ...DEFAULT_SETTINGS.presets.filter((p) => p.kind === "stimulant")];
    }
    s.presets = s.presets.map((p) => (p.id === "c1" ? { ...p, label: "Americano", amount: 128 }
      : p.id === "c3" ? { ...p, label: "Ultra", amount: p.label === "Cold brew" ? 40 : p.amount }
      : p.id === "c4" ? { ...p, label: "Matcha", amount: 70 } : p));
    for (const id of ["a5", "w7"]) {
      if (!s.presets.some((p) => p.id === id)) {
        s.presets = [...s.presets, DEFAULT_SETTINGS.presets.find((p) => p.id === id)];
      }
    }
  }
  return s;
}


export default function HealthLog({ email, onSignOut }) {
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [tab, setTab] = useState("log");
  const [range, setRange] = useState(30);
  const [dayKey, setDayKey] = useState(addDays(toDayKey(new Date()), -1));
  const [doses, setDoses] = useState([]);
  const [sleep, setSleep] = useState([]);
  const [manualSessions, setManualSessions] = useState([]);
  const [lifts, setLifts] = useState([]);
  const [days, setDays] = useState([]);
  const [spend, setSpend] = useState([]);
  const [planned, setPlanned] = useState([]);   // the training plan, once generated: editable records
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  useEffect(() => {
    (async () => {
      const [d, s, se, l, st, dy, sp, pl] = await Promise.all([
        store.get(KEYS.doses), store.get(KEYS.sleep), store.get(KEYS.sessions),
        store.get(KEYS.lifts), store.get(KEYS.settings), store.get(KEYS.days), store.get(KEYS.spend),
        store.get(KEYS.plan),
      ]);
      if (pl) setPlanned(pl);
      if (dy) setDays(dy);
      if (sp) setSpend(sp);
      if (d) setDoses(d);
      if (s) setSleep(s);
      if (se) setManualSessions(se);
      if (l) setLifts(l);
      if (st) setSettings(withDefaults(st));
      setLoaded(true);
      const probe = await store.set("hl2:probe", Date.now());
      setStorageOk(probe);
    })();
  }, []);

  // save 600ms after the last change so a burst of taps becomes one write
  const timers = useRef({});
  const save = useCallback((k, v) => {
    if (!loaded) return;
    clearTimeout(timers.current[k]);
    timers.current[k] = setTimeout(async () => {
      const ok = await store.set(k, v);
      if (!ok) setStorageOk(false);
    }, 600);
  }, [loaded]);
  useEffect(() => { save(KEYS.doses, doses); }, [doses, save]);
  useEffect(() => { save(KEYS.sleep, sleep); }, [sleep, save]);
  useEffect(() => { save(KEYS.sessions, manualSessions); }, [manualSessions, save]);
  useEffect(() => { save(KEYS.lifts, lifts); }, [lifts, save]);
  useEffect(() => { save(KEYS.days, days); }, [days, save]);
  useEffect(() => { save(KEYS.spend, spend); }, [spend, save]);
  useEffect(() => { save(KEYS.plan, planned); }, [planned, save]);
  useEffect(() => { save(KEYS.settings, settings); }, [settings, save]);

  // Strong sets become lift sessions unless a hand-logged lift already covers that day.
  const sessions = useMemo(() => [...manualSessions, ...sessionsFromLifts(lifts, manualSessions)], [manualSessions, lifts]);

  // charts take colours from plain JS, so point them at the chosen palette before anything draws
  const theme = PALETTES[settings.theme] ? settings.theme : "light";
  CURRENT_THEME = theme;
  useEffect(() => {
    const c = PALETTES[theme];
    document.documentElement.style.background = c.paper;
    document.body.style.background = c.paper;
    let meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) { meta = document.createElement("meta"); meta.name = "theme-color"; document.head.appendChild(meta); }
    meta.content = c.paper;
  }, [theme]);

  const addDose = (d) => setDoses((x) => [...x, d]);
  const removeDose = (id) => setDoses((x) => x.filter((d) => d.id !== id));
  const upsertSleep = (rec) => setSleep((x) => mergeBy(x, [rec], (r) => r.date));
  const upsertDay = (rec) => setDays((x) => mergeBy(x, [rec], (r) => r.date));
  const addSession = (s) => setManualSessions((x) => [...x, s]);
  const removeSession = (id) => setManualSessions((x) => x.filter((s) => s.id !== id));
  const resetAll = () => { setDoses([]); setSleep([]); setManualSessions([]); setLifts([]); setDays([]); setSpend([]); setPlanned([]); setSettings(DEFAULT_SETTINGS); };
  const goLog = (k) => { setDayKey(k); setTab("log"); };

  const nextRace = (settings.races || []).filter((r) => r.date >= toDayKey(new Date()) && r.status === "entered")
    .sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
  const raceDate = nextRace ? fromDayKey(nextRace.date) : null;
  const daysOut = raceDate ? Math.ceil((raceDate - new Date()) / 864e5) : null;

  const tabs = [["log", "Log"], ["overview", "Overview"], ["sleep", "Sleep"], ["training", "Training"], ["intake", "Intake"], ["calendar", "Calendar"], ["races", "Races"], ["spend", "Spend"], ["data", "Data"]];

  if (!loaded) {
    return <div className={`hl t-${theme}`}><style>{CSS}</style><div className="wrap"><p className="note">Opening your log…</p></div></div>;
  }

  return (
    <div className={`hl t-${theme}`}>
      <style>{CSS}</style>
      <div className="wrap">
        <header className="top">
          <div className="brand">Health log <span>· {fromDayKey(toDayKey(new Date())).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span></div>
          <div className="race">
            {daysOut != null && daysOut >= 0 ? (
              <><b>{daysOut} days</b>to {nextRace.name || raceType(nextRace.kind).name}{nextRace.goalTime ? `, goal ${nextRace.goalTime}` : ""}</>
            ) : <>No race set</>}
            <div className="themepick" style={{ marginTop: 6 }}>
              <span className="seg" role="group" aria-label="Colour theme">
                {THEMES.map(([id, name]) => (
                  <button key={id} aria-pressed={theme === id} onClick={() => setSettings({ ...settings, theme: id })}>{name}</button>
                ))}
              </span>
            </div>
            <div style={{ marginTop: 4 }}>
              <span style={{ color: "var(--faint)" }}>{email}</span>
              {" · "}<button className="del" onClick={onSignOut} style={{ fontSize: 12, color: "var(--soft)" }}>sign out</button>
            </div>
          </div>
        </header>

        <nav>
          {tabs.map(([id, name]) => (
            <button key={id} className={id} aria-current={tab === id} onClick={() => setTab(id)}>{name}</button>
          ))}
        </nav>

        {tab !== "log" && tab !== "data" && tab !== "calendar" && <RangeBar value={range} onChange={setRange} />}

        {tab === "log" && (
          <Boundary where="The log sheet">
          <Log dayKey={dayKey} setDayKey={setDayKey} doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings}
               addDose={addDose} removeDose={removeDose} upsertSleep={upsertSleep} addSession={addSession} removeSession={removeSession} upsertDay={upsertDay} />
          </Boundary>
        )}
        {tab === "overview" && <Boundary where="Overview"><Overview doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} range={range} goLog={goLog} /></Boundary>}
        {tab === "sleep" && <Boundary where="Sleep"><SleepDash doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} range={range} /></Boundary>}
        {tab === "training" && <Boundary where="Training"><TrainingDash sessions={sessions} days={days} doses={doses} sleep={sleep} settings={settings} setSettings={setSettings} range={range} /></Boundary>}
        {tab === "intake" && <Boundary where="Intake"><IntakeDash doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} range={range} /></Boundary>}
        {tab === "races" && (
          <Boundary where="Races">
            <RacesWrap doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} setSettings={setSettings} />
          </Boundary>
        )}
        {tab === "calendar" && (
          <Boundary where="The calendar">
            <CalendarWrap doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} setSettings={setSettings}
                          planned={planned} setPlanned={setPlanned} />
          </Boundary>
        )}
        {tab === "spend" && (
          <Boundary where="Spend">
            <SpendDashWrap doses={doses} sleep={sleep} sessions={sessions} days={days} spend={spend} setSpend={setSpend}
                           settings={settings} setSettings={setSettings} range={range} />
          </Boundary>
        )}
        {tab === "data" && (
          <Boundary where="The data tab">
          <Data state={{ doses, sleep, sessions: manualSessions, lifts, days, spend, plan: planned, settings }} setSleep={setSleep} setSessions={setManualSessions}
                setLifts={setLifts} setDoses={setDoses} setDays={setDays} setSpend={setSpend} settings={settings} setSettings={setSettings}
                resetAll={resetAll} storageOk={storageOk} />
          </Boundary>
        )}
      </div>
    </div>
  );
}
