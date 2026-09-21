import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import { store } from "./storage";
import { supabase } from "./supabase";
import {
  ResponsiveContainer, LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell, ComposedChart,
} from "recharts";

/* ================================================================== */
/* storage                                                            */
/* ================================================================== */

const KEYS = {
  doses: "hl2:doses", sleep: "hl2:sleep", sessions: "hl2:sessions",
  lifts: "hl2:lifts", days: "hl2:days", settings: "hl2:settings",
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
  dayTags: ["normal", "social", "date", "travel", "work late", "sick", "family"],
  race: { name: "", date: "", goalTime: "" },
  presets: [
    { id: "c1", kind: "caffeine", label: "Drip coffee", amount: 95, unit: "mg" },
    { id: "c2", kind: "caffeine", label: "Espresso", amount: 64, unit: "mg" },
    { id: "c3", kind: "caffeine", label: "Cold brew", amount: 200, unit: "mg" },
    { id: "c4", kind: "caffeine", label: "Tea", amount: 47, unit: "mg" },
    { id: "a1", kind: "alcohol", label: "Beer", amount: 1, unit: "drinks" },
    { id: "a2", kind: "alcohol", label: "Wine", amount: 1, unit: "drinks" },
    { id: "a3", kind: "alcohol", label: "Cocktail", amount: 1.5, unit: "drinks" },
    { id: "a4", kind: "alcohol", label: "Shot", amount: 1, unit: "drinks" },
    { id: "w1", kind: "cannabis", label: "Edible", amount: 10, unit: "mg", ask: true },
    { id: "w3", kind: "cannabis", label: "Preroll", amount: 1, unit: "sessions" },
    { id: "w4", kind: "cannabis", label: "Bong hit", amount: 1, unit: "hits" },
    { id: "w5", kind: "cannabis", label: "Joint", amount: 1, unit: "sessions" },
    { id: "n1", kind: "nicotine", label: "Pouch", amount: 6, unit: "mg", ask: true },
    { id: "n2", kind: "nicotine", label: "Cigarette", amount: 1.5, unit: "mg" },
    { id: "n3", kind: "nicotine", label: "Vape", amount: 3, unit: "mg" },
  ],
};

const KIND_META = {
  caffeine: { color: "var(--caf)", name: "Caffeine", hex: "#8A5A2B" },
  alcohol: { color: "var(--alc)", name: "Alcohol", hex: "#7C3F66" },
  cannabis: { color: "var(--thc)", name: "Cannabis", hex: "#5B4B8A" },
  nicotine: { color: "var(--nic)", name: "Nicotine", hex: "#63736A" },
};
const KIND_ORDER = ["caffeine", "alcohol", "cannabis", "nicotine"];

const RUN_TYPES = ["easy", "long", "tempo", "intervals", "race", "trail"];
const LIFT_TYPES = ["push", "pull", "legs", "upper", "lower", "full body"];
const HEX = { run: "#BE4A2B", lift: "#2E6B4F", sleep: "#33507C", rest: "#8A978D", rhr: "#7C3F66", hours: "#5B7DB0" };

/* ================================================================== */
/* helpers                                                            */
/* ================================================================== */

const uid = () => Math.random().toString(36).slice(2, 10);
const pad = (n) => String(n).padStart(2, "0");
const KM_PER_MI = 1.609344;
const toUnit = (km, u) => (u === "mi" ? km / KM_PER_MI : km);
const fromUnit = (v, u) => (u === "mi" ? v * KM_PER_MI : v);
const round = (n, d = 1) => (n == null || isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const sum = (arr) => arr.reduce((a, b) => a + b, 0);
const numOf = (v) => {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return isNaN(n) ? null : n;
};

function toDayKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}
function fromDayKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(k, n) { const d = fromDayKey(k); d.setDate(d.getDate() + n); return toDayKey(d); }
function mondayOf(k) {
  const d = fromDayKey(k);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDayKey(d);
}
function dayKeyFor(ts, dayStartHour) {
  return toDayKey(new Date(new Date(ts).getTime() - dayStartHour * 3600e3));
}
function lastNDays(n, endKey) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
  return out;
}
function fmtClock(ts) {
  const d = new Date(ts); let h = d.getHours();
  const ap = h >= 12 ? "pm" : "am"; h = h % 12 || 12;
  return `${h}:${pad(d.getMinutes())}${ap}`;
}
function fmtDayLabel(k) {
  return fromDayKey(k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function fmtShort(k) {
  return fromDayKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function minsToHM(m) {
  if (m == null || isNaN(m)) return "—";
  return `${Math.floor(m / 60)}h ${pad(Math.round(m % 60))}m`;
}
function secsToClock(s) {
  if (s == null || isNaN(s) || !isFinite(s)) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.round(s % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}
/* pace of a session in the current unit: from time+distance if both exist, else from a stored pace */
function paceSecOf(s, unit) {
  if (s.movingSec && s.distanceKm) return s.movingSec / toUnit(s.distanceKm, unit);
  if (s.paceSecPerKm) return unit === "mi" ? s.paceSecPerKm * KM_PER_MI : s.paceSecPerKm;
  return null;
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
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pearson(xs, ys) {
  const n = xs.length; if (n < 4) return null;
  const mx = avg(xs), my = avg(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
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
.hl {
  --paper:#EDF0EA; --card:#F8FAF6; --ink:#17211C; --soft:#5C6B61; --faint:#8A978D;
  --rule:#C7D1C6; --rule-soft:#DEE5DC;
  --run:#BE4A2B; --sleep:#33507C; --lift:#2E6B4F; --rest:#8A978D;
  --caf:#8A5A2B; --alc:#7C3F66; --thc:#5B4B8A; --nic:#63736A;
  background:var(--paper); color:var(--ink); min-height:100vh;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  font-size:14px; line-height:1.45; font-variant-numeric:tabular-nums; -webkit-font-smoothing:antialiased;
}
.hl *,.hl *::before,.hl *::after{box-sizing:border-box;}
.hl .wrap{max-width:1080px;margin:0 auto;padding:20px 18px 64px;}
.hl header.top{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;
  padding-bottom:12px;border-bottom:1.5px solid var(--ink);flex-wrap:wrap;}
.hl .brand{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-size:25px;}
.hl .brand span{color:var(--soft);}
.hl .race{text-align:right;font-size:12.5px;color:var(--soft);line-height:1.35;}
.hl .race b{display:block;font-family:"Iowan Old Style",Palatino,Georgia,serif;
  font-size:22px;color:var(--run);font-weight:400;}
.hl nav{display:flex;gap:2px;margin:14px 0 18px;flex-wrap:wrap;}
.hl nav button{background:none;border:none;border-bottom:2px solid transparent;padding:6px 12px;
  font:inherit;font-size:13.5px;color:var(--soft);cursor:pointer;}
.hl nav button:hover{color:var(--ink);}
.hl nav button[aria-current="true"]{color:var(--ink);border-bottom-color:var(--run);}
.hl nav button.log[aria-current="true"]{border-bottom-color:var(--ink);}
.hl nav button:focus-visible,.hl button:focus-visible{outline:2px solid var(--sleep);outline-offset:2px;}
.hl .panel{background:var(--card);border:1px solid var(--rule);margin-bottom:14px;}
.hl .panel > h2{margin:0;padding:9px 14px;font-size:12px;font-weight:600;color:var(--soft);
  border-bottom:1px solid var(--rule-soft);display:flex;justify-content:space-between;align-items:center;gap:10px;}
.hl .panel > h2 .hint{font-weight:400;color:var(--faint);}
.hl .panel .body{padding:14px;}
.hl .grid2{display:grid;grid-template-columns:1fr 1fr;gap:14px;}
.hl .grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
.hl .grid4{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
@media(max-width:820px){.hl .grid4{grid-template-columns:repeat(2,1fr);}}
@media(max-width:760px){.hl .grid2,.hl .grid3{grid-template-columns:1fr;}}
.hl .stat{display:flex;flex-direction:column;gap:1px;}
.hl .stat .v{font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:27px;line-height:1.1;}
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
.hl .chip{border:1px solid var(--rule);background:#fff;border-radius:2px;padding:6px 10px;
  font:inherit;font-size:12.5px;cursor:pointer;display:flex;align-items:center;gap:7px;transition:transform .08s ease;}
.hl .chip:hover{border-color:currentColor;}
.hl .chip:active{transform:scale(.96);}
.hl .chip .dot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;}
.hl .chip .amt{color:var(--faint);font-size:11px;}
.hl .chip span.lbl{color:var(--ink);}
.hl .chip.caffeine{color:var(--caf);} .hl .chip.alcohol{color:var(--alc);}
.hl .chip.cannabis{color:var(--thc);} .hl .chip.nicotine{color:var(--nic);}
.hl .chip[aria-pressed="true"]{border-color:currentColor;background:var(--paper);}
.hl .seg{display:inline-flex;border:1px solid var(--rule);border-radius:2px;overflow:hidden;}
.hl .seg button{background:#fff;border:none;border-right:1px solid var(--rule);padding:6px 14px;font:inherit;
  font-size:13px;color:var(--soft);cursor:pointer;}
.hl .seg button:last-child{border-right:none;}
.hl .seg button[aria-pressed="true"]{background:var(--ink);color:var(--card);}
.hl .seg button.run[aria-pressed="true"]{background:var(--run);}
.hl .seg button.lift[aria-pressed="true"]{background:var(--lift);}
.hl .seg button.rest[aria-pressed="true"]{background:var(--soft);}
.hl .tchip{border:1px solid var(--rule);background:#fff;border-radius:14px;padding:4px 11px;font:inherit;
  font-size:12.5px;color:var(--soft);cursor:pointer;}
.hl .tchip[aria-pressed="true"]{border-color:currentColor;color:var(--ink);background:var(--paper);}
.hl .tag{display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;color:#fff;line-height:1.5;}
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
.hl .del:hover{color:var(--run);}
.hl input,.hl select,.hl textarea{font:inherit;font-size:13px;padding:5px 7px;border:1px solid var(--rule);
  background:#fff;color:var(--ink);border-radius:2px;width:100%;}
.hl input:focus,.hl select:focus,.hl textarea:focus{outline:2px solid var(--sleep);outline-offset:-1px;}
.hl input.big{font-family:"Iowan Old Style",Palatino,Georgia,serif;font-size:22px;padding:6px 8px;}
.hl label.f{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--soft);}
.hl .row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;}
.hl button.solid{background:var(--ink);color:var(--card);border:none;padding:7px 14px;font:inherit;
  font-size:13px;cursor:pointer;border-radius:2px;}
.hl button.solid:hover{background:var(--lift);}
.hl button.solid:disabled{opacity:.4;cursor:default;background:var(--ink);}
.hl button.danger{border:1px solid var(--run);color:var(--run);background:none;padding:6px 12px;
  font:inherit;font-size:12.5px;cursor:pointer;border-radius:2px;}
.hl .note{font-size:12px;color:var(--soft);line-height:1.5;}
.hl .flag{color:var(--run);} .hl .ok{color:var(--lift);}
.hl .empty{color:var(--faint);font-size:12.5px;padding:10px 0;}
.hl .bar-track{height:5px;background:var(--rule-soft);border-radius:3px;overflow:hidden;margin-top:5px;}
.hl .bar-fill{height:100%;border-radius:3px;}
.hl .legend{display:flex;gap:14px;flex-wrap:wrap;font-size:11px;color:var(--soft);margin-top:8px;}
.hl .legend i{display:inline-block;width:9px;height:9px;margin-right:5px;border-radius:2px;vertical-align:-1px;}
.hl .divline{height:1px;background:var(--rule-soft);margin:14px 0;}
.hl .saved{font-size:11.5px;color:var(--lift);}
.hl .rc-tip{background:#fff;border:1px solid var(--rule);padding:6px 9px;font-size:12px;color:var(--ink);}
.hl .rc-tip b{display:block;color:var(--soft);font-weight:500;margin-bottom:2px;}
@media (prefers-reduced-motion:reduce){.hl *{transition:none!important;}}
`;

/* ================================================================== */
/* small shared bits                                                  */
/* ================================================================== */

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

const axisStyle = { fontSize: 10.5, fill: "#8A978D" };
const gridStroke = "#DEE5DC";

function Chart({ h = 180, children }) {
  return <div style={{ width: "100%", height: h }}><ResponsiveContainer>{children}</ResponsiveContainer></div>;
}

function RangeToggle({ value, onChange, options }) {
  return (
    <span className="seg" style={{ fontSize: 12 }}>
      {options.map((o) => (
        <button key={o} aria-pressed={value === o} onClick={() => onChange(o)} style={{ padding: "3px 10px", fontSize: 12 }}>{o}d</button>
      ))}
    </span>
  );
}

/* ================================================================== */
/* Log — the one-sheeter                                              */
/* ================================================================== */

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
  return useMemo(() => {
    const byDay = new Map();
    const day = (k) => {
      if (!byDay.has(k)) byDay.set(k, { date: k, sleep: null, sessions: [], caf: 0, alc: 0, thc: 0, nic: 0, entries: [], tags: [], note: "", steps: null });
      return byDay.get(k);
    };
    for (const s of sleep) if (s.score != null || s.asleepMin != null || s.restingHr != null || s.bodyBattery != null || s.bedtime) day(s.date).sleep = s;
    for (const d of days) { const x = day(d.date); x.tags = d.tags || []; x.note = d.note || ""; x.steps = d.steps ?? null; }
    for (const s of sessions) day(s.date).sessions.push(s);
    for (const d of doses) {
      const k = dayKeyFor(d.ts, settings.dayStartHour); const x = day(k);
      x.entries.push(d);
      if (d.kind === "caffeine") x.caf += d.amount;
      else if (d.kind === "alcohol") x.alc += d.amount;
      else if (d.kind === "cannabis") x.thc += 1;
      else if (d.kind === "nicotine") x.nic += 1;
    }
    for (const x of byDay.values()) {
      x.runKm = sum(x.sessions.filter((s) => s.kind === "run").map((s) => s.distanceKm || 0));
      x.hasRun = x.sessions.some((s) => s.kind === "run");
      x.hasLift = x.sessions.some((s) => s.kind === "lift");
      x.isRest = !x.hasRun && !x.hasLift && x.sessions.some((s) => s.kind === "rest");
    }
    const get = (k) => byDay.get(k) || { date: k, sleep: null, sessions: [], caf: 0, alc: 0, thc: 0, nic: 0, entries: [], tags: [], note: "", steps: null, runKm: 0, hasRun: false, hasLift: false, isRest: false };
    return { byDay, get };
  }, [doses, sleep, sessions, days, settings.dayStartHour]);
}

function daysSince(doses, kind) {
  const t = doses.filter((d) => d.kind === kind).map((d) => new Date(d.ts).getTime()).sort((a, b) => b - a)[0];
  return t ? Math.floor((Date.now() - t) / 864e5) : null;
}

function weekBuckets(n, endKey) {
  const thisMon = mondayOf(endKey);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(thisMon, -7 * i));
  return out;
}

/* ================================================================== */
/* Overview                                                           */
/* ================================================================== */

function Overview({ doses, sleep, sessions, days, settings, goLog }) {
  const daily = useDaily({ doses, sleep, sessions, days, settings });
  const today = toDayKey(new Date());
  const d7 = lastNDays(7, today), d30 = lastNDays(30, today), d14 = lastNDays(14, today);
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
    else if (i === 0) continue; // today may not be logged yet
    else break;
  }

  const trend = d30.map((k) => {
    const x = daily.get(k);
    return { k, label: fmtShort(k), score: x.sleep?.score ?? null, run: x.runKm ? round(toUnit(x.runKm, u), 1) : 0, lift: x.hasLift ? 1 : 0 };
  });

  const gap = (a, b) => (a != null && b != null ? `${a >= b ? "+" : ""}${round(a - b, 1)} vs 30d` : "30d avg —");

  return (
    <>
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
              <Stat v={Math.round(cafAvg7 ?? 0)} l="mg caffeine / day" color={KIND_META.caffeine.hex}
                    sub={cafAvg30 != null ? `${Math.round(cafAvg30)} over 30d` : ""}
                    bar={{ pct: ((cafAvg7 ?? 0) / settings.caffeineLimitMg) * 100, color: (cafAvg7 ?? 0) > settings.caffeineLimitMg ? HEX.run : KIND_META.caffeine.hex }} />
              <Stat v={round(wkDrinks, 1) ?? 0} l={`drinks of ${settings.drinksWeeklyLimit}`} color={KIND_META.alcohol.hex}
                    sub={[["alcohol", "drink"], ["cannabis", "cannabis"], ["nicotine", "nicotine"]]
                      .map(([k, n]) => { const d = daysSince(doses, k); return d != null ? `${d}d since ${n}` : null; })
                      .filter(Boolean).join(" · ")}
                    bar={{ pct: (wkDrinks / settings.drinksWeeklyLimit) * 100, color: wkDrinks > settings.drinksWeeklyLimit ? HEX.run : KIND_META.alcohol.hex }} />
            </div>
          </div>
        </div>
      </div>

      <FortnightStrip days={d14} daily={daily} settings={settings} onPick={goLog} />

      <div className="panel">
        <h2>Thirty days <span className="hint">sleep score against training load</span></h2>
        <div className="body" style={{ paddingTop: 8 }}>
          <Chart h={210}>
            <ComposedChart data={trend} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={gridStroke} vertical={false} />
              <XAxis dataKey="label" tick={axisStyle} interval={4} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
              <YAxis yAxisId="score" domain={[40, 100]} tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis yAxisId="run" orientation="right" tick={axisStyle} tickLine={false} axisLine={false} />
              <Tooltip content={<Tip fmt={(p) => p.dataKey === "run" ? `${p.value} ${u}` : p.dataKey === "lift" ? (p.value ? "yes" : "no") : p.value} />} />
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

      <Ledger days={d30} daily={daily} settings={settings} onPick={goLog} />
    </>
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
                  {[x.caf ? `${Math.round(x.caf)}mg` : null, x.alc ? `${round(x.alc, 1)} drk` : null, x.thc ? `${x.thc} thc` : null, x.nic ? `${x.nic} nic` : null].filter(Boolean).join(" · ") || "—"}
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
          <line x1={0} x2={W} y1={barTop + barH} y2={barTop + barH} stroke="#C7D1C6" />
          <line x1={0} x2={W} y1={barTop + barH - (settings.sleepScoreGoal / 100) * barH} y2={barTop + barH - (settings.sleepScoreGoal / 100) * barH} stroke="#33507C" strokeDasharray="3 4" opacity={0.5} />
          {days.map((k, i) => {
            const x = daily.get(k); const cx = i * colW + colW / 2;
            const score = x.sleep?.score;
            const h = score != null ? (score / 100) * barH : 0;
            const tag = x.hasRun && x.hasLift ? "both" : x.hasRun ? "run" : x.hasLift ? "lift" : x.isRest ? "rest" : null;
            const dots = x.entries.slice(0, 8);
            const dow = fromDayKey(k).toLocaleDateString(undefined, { weekday: "narrow" });
            return (
              <g key={k} onClick={() => onPick(k)} style={{ cursor: "pointer" }}>
                <rect x={i * colW} y={0} width={colW} height={H} fill={k === today ? "#33507C" : "transparent"} opacity={0.05} />
                {score != null ? (
                  <>
                    <rect x={cx - 14} y={barTop + barH - h} width={28} height={h} fill={HEX.sleep} opacity={score >= settings.sleepScoreGoal ? 0.9 : 0.5} />
                    <text x={cx} y={barTop + barH - h - 4} fontSize="10.5" fill="#33507C" textAnchor="middle">{score}</text>
                  </>
                ) : (
                  <text x={cx} y={barTop + barH - 4} fontSize="10" fill="#C7D1C6" textAnchor="middle">·</text>
                )}
                {tag && (
                  <>
                    <rect x={cx - 20} y={tagY - 10} width={40} height={16} rx={8}
                          fill={tag === "run" ? HEX.run : tag === "lift" ? HEX.lift : tag === "both" ? "#6B4A3A" : "#C7D1C6"} />
                    <text x={cx} y={tagY + 2} fontSize="9.5" fill={tag === "rest" ? "#5C6B61" : "#fff"} textAnchor="middle">{tag}</text>
                  </>
                )}
                {dots.map((d, j) => (
                  <circle key={d.id} cx={cx - ((dots.length - 1) * 4) + j * 8} cy={dotsY} r={3} fill={KIND_META[d.kind]?.hex || "#999"} />
                ))}
                {x.tags.length > 0 && x.tags[0] !== "normal" && (
                  <text x={cx} y={dayTagY} fontSize="9.5" fill="#33507C" textAnchor="middle">{x.tags[0]}{x.tags.length > 1 ? " +" : ""}</text>
                )}
                <text x={cx} y={H - 4} fontSize="10" fill={k === today ? "#17211C" : "#8A978D"} textAnchor="middle">
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
          <span><i style={{ background: KIND_META.caffeine.hex }} />caffeine</span>
          <span><i style={{ background: KIND_META.alcohol.hex }} />alcohol</span>
          <span><i style={{ background: KIND_META.cannabis.hex }} />cannabis</span>
          <span><i style={{ background: KIND_META.nicotine.hex }} />nicotine</span>
        </div>
      </div>
    </div>
  );
}

/* ================================================================== */
/* Sleep                                                              */
/* ================================================================== */

function SleepDash({ doses, sleep, sessions, days: dayRecs, settings }) {
  const daily = useDaily({ doses, sleep, sessions, days: dayRecs, settings });
  const [range, setRange] = useState(30);
  const today = toDayKey(new Date());
  const days = lastNDays(range, today);

  const rows = days.map((k) => {
    const x = daily.get(k); const prev = daily.get(addDays(k, -1));
    return {
      k, label: fmtShort(k),
      score: x.sleep?.score ?? null,
      hours: x.sleep?.asleepMin != null ? round(x.sleep.asleepMin / 60, 2) : null,
      rhr: x.sleep?.restingHr ?? null,
      bb: x.sleep?.bodyBattery ?? null,
      bed: bedtimeMins(x.sleep?.bedtime),
      prevAlc: prev.alc, prevCaf: prev.caf, prevTrained: prev.hasRun || prev.hasLift, prevTags: prev.tags,
    };
  });
  const scored = rows.filter((r) => r.score != null);
  const scores = scored.map((r) => r.score);
  const hoursArr = rows.filter((r) => r.hours != null).map((r) => r.hours);
  const rhrArr = rows.filter((r) => r.rhr != null).map((r) => r.rhr);
  const bbArr = rows.filter((r) => r.bb != null).map((r) => r.bb);
  const bedArr = rows.filter((r) => r.bed != null).map((r) => r.bed);
  const rBed = pearson(rows.filter((r) => r.bed != null && r.score != null).map((r) => r.bed), rows.filter((r) => r.bed != null && r.score != null).map((r) => r.score));
  const tagRows = settings.dayTags.map((t) => {
    const after = scored.filter((r) => r.prevTags.includes(t));
    return { tag: t, score: after.length ? Math.round(avg(after.map((r) => r.score))) : null,
      bb: after.filter((r) => r.bb != null).length ? Math.round(avg(after.filter((r) => r.bb != null).map((r) => r.bb))) : null, n: after.length };
  }).filter((r) => r.n);

  const weekday = [1, 2, 3, 4, 5, 6, 0].map((dow) => {
    const s = rows.filter((r) => r.score != null && fromDayKey(r.k).getDay() === dow).map((r) => r.score);
    return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow], score: s.length ? round(avg(s), 0) : null, n: s.length };
  });

  const afterDrinks = scored.filter((r) => r.prevAlc > 0).map((r) => r.score);
  const dry = scored.filter((r) => r.prevAlc === 0).map((r) => r.score);
  const afterTrain = scored.filter((r) => r.prevTrained).map((r) => r.score);
  const noTrain = scored.filter((r) => !r.prevTrained).map((r) => r.score);
  const rAlc = pearson(scored.map((r) => r.prevAlc), scores);
  const rCaf = pearson(scored.map((r) => r.prevCaf), scores);
  const rRhr = pearson(scored.filter((r) => r.rhr != null).map((r) => r.rhr), scored.filter((r) => r.rhr != null).map((r) => r.score));

  const recent = [...sleep].filter((s) => s.score != null || s.asleepMin != null || s.bodyBattery != null).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 14);

  const rWord = (r) => (r == null ? "not enough nights yet" : Math.abs(r) < 0.2 ? "no real relationship" : Math.abs(r) < 0.5 ? "a weak link" : "a clear link");

  return (
    <>
      <div className="panel">
        <h2>Sleep <RangeToggle value={range} onChange={setRange} options={[30, 90]} /></h2>
        <div className="body">
          <div className="grid4" style={{ gap: 12 }}>
            <Stat v={scores.length ? Math.round(avg(scores)) : null} l="avg score" color={HEX.sleep}
                  sub={scores.length ? `median ${Math.round(median(scores))}, ${scores.length} nights` : "no nights logged"} />
            <Stat v={hoursArr.length ? minsToHM(avg(hoursArr) * 60) : null} l="avg asleep" color={HEX.hours}
                  sub={hoursArr.length ? `${hoursArr.filter((h) => h >= settings.sleepHoursGoal).length} of ${hoursArr.length} hit ${settings.sleepHoursGoal}h` : ""} />
            <Stat v={rhrArr.length ? Math.round(avg(rhrArr)) : null} l="avg resting HR" color={HEX.rhr}
                  sub={rhrArr.length ? `${Math.min(...rhrArr)}–${Math.max(...rhrArr)} range` : ""} />
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
        <h2>Score and hours</h2>
        <div className="body" style={{ paddingTop: 8 }}>
          <Chart h={220}>
            <ComposedChart data={rows} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={gridStroke} vertical={false} />
              <XAxis dataKey="label" tick={axisStyle} interval={Math.max(2, Math.floor(range / 8))} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
              <YAxis yAxisId="score" domain={[40, 100]} tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis yAxisId="hours" orientation="right" domain={[0, 10]} tick={axisStyle} tickLine={false} axisLine={false} />
              <Tooltip content={<Tip />} />
              <ReferenceLine yAxisId="score" y={settings.sleepScoreGoal} stroke={HEX.sleep} strokeDasharray="3 4" opacity={0.6} />
              <Bar yAxisId="hours" dataKey="hours" name="Hours" fill={HEX.hours} opacity={0.35} radius={[2, 2, 0, 0]} />
              <Line yAxisId="score" type="monotone" dataKey="score" name="Score" stroke={HEX.sleep} strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
              <Line yAxisId="score" type="monotone" dataKey="bb" name="Body battery" stroke={HEX.hours} strokeWidth={1.5} strokeDasharray="4 3" dot={false} connectNulls />
            </ComposedChart>
          </Chart>
          <div className="legend">
            <span><i style={{ background: HEX.sleep }} />score (left, dashed = goal)</span>
            <span><i style={{ background: HEX.hours }} />body battery on waking (left, dashed)</span>
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
                <LineChart data={rows} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid stroke={gridStroke} vertical={false} />
                  <XAxis dataKey="label" tick={axisStyle} interval={Math.max(2, Math.floor(range / 6))} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
                  <YAxis domain={["dataMin - 3", "dataMax + 3"]} tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip content={<Tip />} />
                  <Line type="monotone" dataKey="rhr" name="RHR" stroke={HEX.rhr} strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
                </LineChart>
              </Chart>
            ) : <p className="empty">Add resting HR on the Log tab and it will chart here.</p>}
            {rRhr != null && <p className="note" style={{ marginTop: 6 }}>RHR against score: {rWord(rRhr)} (r = {round(rRhr, 2)}). A higher RHR on a lower-score night is the usual pattern.</p>}
          </div>
        </div>
        <div className="panel">
          <h2>Bedtime</h2>
          <div className="body" style={{ paddingTop: 8 }}>
            {bedArr.length ? (
              <Chart h={170}>
                <LineChart data={rows} margin={{ top: 6, right: 8, left: -10, bottom: 0 }}>
                  <CartesianGrid stroke={gridStroke} vertical={false} />
                  <XAxis dataKey="label" tick={axisStyle} interval={Math.max(2, Math.floor(range / 6))} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
                  <YAxis domain={["dataMin - 30", "dataMax + 30"]} tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v) => fmtBedtime(v)} width={54} />
                  <Tooltip content={<Tip fmt={(p) => fmtBedtime(p.value)} />} />
                  <Line type="monotone" dataKey="bed" name="Bedtime" stroke={HEX.sleep} strokeWidth={2} dot={{ r: 2.5 }} connectNulls />
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
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="day" tick={axisStyle} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
                <YAxis domain={[40, 100]} tick={axisStyle} tickLine={false} axisLine={false} />
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
                <tr><td>After drinking</td><td className="num" style={{ color: KIND_META.alcohol.hex }}>{afterDrinks.length ? Math.round(avg(afterDrinks)) : "—"}</td><td className="num">{afterDrinks.length}</td></tr>
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
              Small samples swing a lot; read this after a month or two of nights.
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

function TrainingDash({ sessions, days: dayRecs, settings, setSettings }) {
  const today = toDayKey(new Date());
  const u = settings.distanceUnit;
  const [range, setRange] = useState(30);
  const days = new Set(lastNDays(range, today));
  const inRange = sessions.filter((s) => days.has(s.date));
  const runs = inRange.filter((s) => s.kind === "run");
  const lifts = inRange.filter((s) => s.kind === "lift");
  const rests = inRange.filter((s) => s.kind === "rest");

  const weeks = weekBuckets(12, today).map((mon) => {
    const wk = sessions.filter((s) => s.date >= mon && s.date < addDays(mon, 7));
    const km = sum(wk.filter((s) => s.kind === "run").map((s) => s.distanceKm || 0));
    return { mon, label: fmtShort(mon), dist: round(toUnit(km, u), 1) ?? 0, runs: wk.filter((s) => s.kind === "run").length, lifts: wk.filter((s) => s.kind === "lift").length };
  });

  const runMix = RUN_TYPES.map((t) => ({ type: t, n: runs.filter((r) => r.type === t).length, km: sum(runs.filter((r) => r.type === t).map((r) => r.distanceKm || 0)) })).filter((x) => x.n);
  const liftMix = LIFT_TYPES.map((t) => ({ type: t, n: lifts.filter((r) => r.type === t).length })).filter((x) => x.n);

  const totalKm = sum(runs.map((r) => r.distanceKm || 0));
  const paced = runs.map((r) => ({ p: paceSecOf(r, u), d: r.distanceKm || 0 })).filter((x) => x.p);
  const avgPace = paced.length ? (paced.every((x) => x.d) ? sum(paced.map((x) => x.p * toUnit(x.d, u))) / toUnit(sum(paced.map((x) => x.d)), u) : avg(paced.map((x) => x.p))) : null;
  const stepsArr = lastNDays(range, today).map((k) => dayRecs.find((d) => d.date === k)?.steps).filter((x) => x != null);
  const longest = runs.reduce((a, r) => ((r.distanceKm || 0) > (a?.distanceKm || 0) ? r : a), null);

  const raceDate = settings.race.date ? fromDayKey(settings.race.date) : null;
  const daysOut = raceDate ? Math.ceil((raceDate - new Date()) / 864e5) : null;
  const goalSec = parseGoalTime(settings.race.goalTime);
  const setRace = (patch) => setSettings({ ...settings, race: { ...settings.race, ...patch } });

  const recent = [...sessions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.ts - a.ts)).slice(0, 20);

  return (
    <>
      <div className="panel">
        <h2>Training <RangeToggle value={range} onChange={setRange} options={[30, 90]} /></h2>
        <div className="body">
          <div className="grid4" style={{ gap: 12 }}>
            <Stat v={round(toUnit(totalKm, u), 1) ?? 0} l={`${u} run`} color={HEX.run}
                  sub={`${runs.length} run${runs.length === 1 ? "" : "s"}, ${round(toUnit(totalKm, u) / (range / 7), 1)} ${u}/week`} />
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
        <h2>Weekly mileage <span className="hint">last 12 weeks, dashed line = target</span></h2>
        <div className="body" style={{ paddingTop: 8 }}>
          <Chart h={200}>
            <ComposedChart data={weeks} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={gridStroke} vertical={false} />
              <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
              <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
              <Tooltip content={<Tip fmt={(p) => p.dataKey === "dist" ? `${p.value} ${u}` : p.value} />} />
              <ReferenceLine y={settings.weeklyDistanceTarget} stroke={HEX.run} strokeDasharray="3 4" opacity={0.6} />
              <Bar dataKey="dist" name="Distance" radius={[2, 2, 0, 0]}>
                {weeks.map((w, i) => <Cell key={i} fill={HEX.run} opacity={w.dist >= settings.weeklyDistanceTarget ? 0.95 : 0.55} />)}
              </Bar>
              <Line type="monotone" dataKey="lifts" name="Lifts" stroke={HEX.lift} strokeWidth={1.5} dot={{ r: 2.5 }} />
            </ComposedChart>
          </Chart>
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
          <h2>Run mix <span className="hint">last {range} days</span></h2>
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
          <h2>Lift mix <span className="hint">last {range} days</span></h2>
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

      <div className="grid2">
        <div className="panel">
          <h2>Race</h2>
          <div className="body">
            <div className="row">
              <label className="f" style={{ flex: 1, minWidth: 140 }}>Name<input value={settings.race.name} placeholder="Brooklyn Half" onChange={(e) => setRace({ name: e.target.value })} /></label>
              <label className="f" style={{ width: 150 }}>Date<input type="date" value={settings.race.date} onChange={(e) => setRace({ date: e.target.value })} /></label>
              <label className="f" style={{ width: 110 }}>Goal time<input value={settings.race.goalTime} placeholder="1:45:00" onChange={(e) => setRace({ goalTime: e.target.value })} /></label>
            </div>
            <p className="note" style={{ marginTop: 10 }}>
              {daysOut != null && daysOut >= 0
                ? <>{daysOut} days out, {Math.floor(daysOut / 7)} full weeks.{goalSec && avgPace ? ` Goal pace ${secsToClock(goalSec / 13.1)}/${u} if it's a half; your recent average is ${secsToClock(avgPace)}/${u}.` : ""}</>
                : "Set a date and the countdown shows in the header."}
            </p>
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
            ) : <p className="empty">Log a workout on the Log tab or import Strava/Strong on the Data tab.</p>}
          </div>
        </div>
      </div>
    </>
  );
}

/* ================================================================== */
/* Intake                                                             */
/* ================================================================== */

function IntakeDash({ doses, sleep, sessions, days, settings }) {
  const daily = useDaily({ doses, sleep, sessions, days, settings });
  const today = toDayKey(new Date());
  const d30 = lastNDays(30, today);
  const d90 = lastNDays(90, today);

  const rows = d30.map((k) => { const x = daily.get(k); return { k, label: fmtShort(k), caf: Math.round(x.caf), alc: round(x.alc, 1) ?? 0, thc: x.thc, nic: x.nic }; });
  const weeks = weekBuckets(12, today).map((mon) => {
    const wk = lastNDays(7, addDays(mon, 6)).map((k) => daily.get(k));
    return { label: fmtShort(mon), alc: round(sum(wk.map((x) => x.alc)), 1) ?? 0, caf: Math.round(avg(wk.map((x) => x.caf)) ?? 0), thc: sum(wk.map((x) => x.thc)), nic: sum(wk.map((x) => x.nic)) };
  });

  const usedDays = (field) => d30.filter((k) => daily.get(k)[field] > 0).length;
  const longestClean = (field) => {
    let best = 0, cur = 0;
    for (const k of d90) { if (daily.get(k)[field] > 0) { best = Math.max(best, cur); cur = 0; } else cur++; }
    return Math.max(best, cur);
  };
  const thisWeek = lastNDays(7, today).filter((k) => k >= mondayOf(today));
  const wkDrinks = sum(thisWeek.map((k) => daily.get(k).alc));
  const overCaf = d30.filter((k) => daily.get(k).caf > settings.caffeineLimitMg).length;

  const recent = [...doses].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 20);

  return (
    <>
      <div className="panel">
        <h2>Intake <span className="hint">last 30 days</span></h2>
        <div className="body">
          <div className="grid4" style={{ gap: 12 }}>
            <Stat v={Math.round(avg(rows.map((r) => r.caf)) ?? 0)} l="mg caffeine / day" color={KIND_META.caffeine.hex}
                  sub={overCaf ? `${overCaf} day${overCaf === 1 ? "" : "s"} over ${settings.caffeineLimitMg} mg` : `never over ${settings.caffeineLimitMg} mg`} />
            <Stat v={round(sum(rows.map((r) => r.alc)), 1) ?? 0} l="drinks in 30 days" color={KIND_META.alcohol.hex}
                  sub={`${usedDays("alc")} drinking days · ${round(wkDrinks, 1)} of ${settings.drinksWeeklyLimit} this week`}
                  bar={{ pct: (wkDrinks / settings.drinksWeeklyLimit) * 100, color: wkDrinks > settings.drinksWeeklyLimit ? HEX.run : KIND_META.alcohol.hex }} />
            <Stat v={usedDays("thc")} l="cannabis days" color={KIND_META.cannabis.hex}
                  sub={`${daysSince(doses, "cannabis") ?? "—"}d since last · longest break ${longestClean("thc")}d`} />
            <Stat v={usedDays("nic")} l="nicotine days" color={KIND_META.nicotine.hex}
                  sub={`${daysSince(doses, "nicotine") ?? "—"}d since last · longest break ${longestClean("nic")}d`} />
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Caffeine by day <span className="hint">dashed = daily limit</span></h2>
          <div className="body" style={{ paddingTop: 8 }}>
            <Chart h={170}>
              <BarChart data={rows} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="label" tick={axisStyle} interval={5} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                <Tooltip content={<Tip fmt={(p) => `${p.value} mg`} />} />
                <ReferenceLine y={settings.caffeineLimitMg} stroke={HEX.run} strokeDasharray="3 4" opacity={0.6} />
                <Bar dataKey="caf" name="Caffeine" radius={[2, 2, 0, 0]}>
                  {rows.map((r, i) => <Cell key={i} fill={r.caf > settings.caffeineLimitMg ? HEX.run : KIND_META.caffeine.hex} opacity={0.8} />)}
                </Bar>
              </BarChart>
            </Chart>
          </div>
        </div>
        <div className="panel">
          <h2>Drinks by week <span className="hint">dashed = weekly limit</span></h2>
          <div className="body" style={{ paddingTop: 8 }}>
            <Chart h={170}>
              <BarChart data={weeks} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<Tip />} />
                <ReferenceLine y={settings.drinksWeeklyLimit} stroke={HEX.run} strokeDasharray="3 4" opacity={0.6} />
                <Bar dataKey="alc" name="Drinks" radius={[2, 2, 0, 0]}>
                  {weeks.map((w, i) => <Cell key={i} fill={w.alc > settings.drinksWeeklyLimit ? HEX.run : KIND_META.alcohol.hex} opacity={0.8} />)}
                </Bar>
              </BarChart>
            </Chart>
          </div>
        </div>
      </div>

      <div className="grid2">
        <div className="panel">
          <h2>Cannabis and nicotine by week <span className="hint">entries per week</span></h2>
          <div className="body" style={{ paddingTop: 8 }}>
            <Chart h={170}>
              <BarChart data={weeks} margin={{ top: 6, right: 8, left: -18, bottom: 0 }}>
                <CartesianGrid stroke={gridStroke} vertical={false} />
                <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: "#C7D1C6" }} />
                <YAxis tick={axisStyle} tickLine={false} axisLine={false} allowDecimals={false} />
                <Tooltip content={<Tip />} />
                <Bar dataKey="thc" name="Cannabis" fill={KIND_META.cannabis.hex} opacity={0.8} radius={[2, 2, 0, 0]} />
                <Bar dataKey="nic" name="Nicotine" fill={KIND_META.nicotine.hex} opacity={0.8} radius={[2, 2, 0, 0]} />
              </BarChart>
            </Chart>
            <div className="legend">
              <span><i style={{ background: KIND_META.cannabis.hex }} />cannabis</span>
              <span><i style={{ background: KIND_META.nicotine.hex }} />nicotine</span>
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
      </div>
    </>
  );
}

/* ================================================================== */
/* Data                                                               */
/* ================================================================== */

function Data({ state, setSleep, setSessions, setLifts, setDoses, setDays, settings, setSettings, resetAll, storageOk }) {
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
      ...state.doses.map((d) => dayKeyFor(d.ts, settings.dayStartHour))]);
    const rows = [...keys].sort().map((k) => {
      const sl = state.sleep.find((s) => s.date === k);
      const ses = state.sessions.filter((s) => s.date === k);
      const ds = state.doses.filter((d) => dayKeyFor(d.ts, settings.dayStartHour) === k);
      const dy = state.days.find((d) => d.date === k);
      const kindSum = (kind) => ds.filter((d) => d.kind === kind).reduce((a, b) => a + b.amount, 0);
      const runPaces = ses.filter((s) => s.kind === "run").map((s) => paceSecOf(s, settings.distanceUnit)).filter(Boolean);
      return {
        date: k, sleep_score: sl?.score ?? "", hours_asleep: sl?.asleepMin != null ? round(sl.asleepMin / 60, 2) : "", resting_hr: sl?.restingHr ?? "",
        body_battery: sl?.bodyBattery ?? "", bedtime: sl?.bedtime ?? "",
        day_tags: (dy?.tags || []).join(" | "), day_note: dy?.note ?? "", steps: dy?.steps ?? "",
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
    garmin: "Garmin Connect on the web: Reports, Sleep, set the date range, Export CSV. Score, duration, resting HR, body battery and bedtime are read if present; the rest is ignored.",
    garminact: `Garmin Connect on the web: Activities, All Activities, then Export CSV at the top right. Only runs are read. Distance is taken in ${settings.distanceUnit}, matching your Garmin display unit; switch the unit above first if yours differs.`,
    strava: "Strava on the web: Settings, My Account, Download or Delete Your Account, request the archive. Use activities.csv when it arrives. Slow, but complete.",
    strong: "Strong app: Settings, Export Data. It emails you a CSV of every set. Sets roll up into one lift session per workout.",
  };

  return (
    <>
      {!storageOk && (
        <div className="panel" style={{ borderColor: "var(--run)" }}>
          <h2 style={{ color: "var(--run)" }}>Not saving</h2>
          <div className="body">
            <p className="note">
              The app could not write to the database, so nothing you log will stick until this clears.
              {store.lastError ? <><br /><b style={{ color: "var(--run)" }}>Reason: {store.lastError}</b></> : ""}
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
            {msg && <span className="note" style={{ color: msg.bad ? "var(--run)" : "var(--lift)" }}>{msg.text}</span>}
          </div>
          <div className="divline" />
          <p className="note">
            Column names are matched loosely, so exports from different app versions still land.
            Re-importing the same file updates rows rather than duplicating them.
            On file: {state.sleep.length} nights, {state.sessions.length} sessions, {state.lifts.length} sets,
            {" "}{state.doses.length} intake entries, {state.days.length} day notes.
          </p>
        </div>
      </div>

      <StravaPanel />

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
        {msg && <p className="note" style={{ marginTop: 10, color: msg.bad ? "var(--run)" : "var(--lift)" }}>{msg.text}</p>}
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
  if (!Array.isArray(s.presets) || !s.presets.length) s.presets = DEFAULT_SETTINGS.presets;
  else {
    // bring saved chips in line with the current defaults without touching ones you added yourself
    s.presets = s.presets
      .filter((p) => !["c5", "w6", "w2"].includes(p.id))
      .map((p) => (p.id === "w1" ? { ...p, label: "Edible", amount: p.amount || 10, ask: true }
        : p.id === "n1" ? { ...p, ask: true } : p));
  }
  return s;
}


export default function HealthLog({ email, onSignOut }) {
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [tab, setTab] = useState("log");
  const [dayKey, setDayKey] = useState(addDays(toDayKey(new Date()), -1));
  const [doses, setDoses] = useState([]);
  const [sleep, setSleep] = useState([]);
  const [manualSessions, setManualSessions] = useState([]);
  const [lifts, setLifts] = useState([]);
  const [days, setDays] = useState([]);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);

  useEffect(() => {
    (async () => {
      const [d, s, se, l, st, dy] = await Promise.all([
        store.get(KEYS.doses), store.get(KEYS.sleep), store.get(KEYS.sessions),
        store.get(KEYS.lifts), store.get(KEYS.settings), store.get(KEYS.days),
      ]);
      if (dy) setDays(dy);
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
  useEffect(() => { save(KEYS.settings, settings); }, [settings, save]);

  // Strong sets become lift sessions unless a hand-logged lift already covers that day.
  const sessions = useMemo(() => [...manualSessions, ...sessionsFromLifts(lifts, manualSessions)], [manualSessions, lifts]);

  const addDose = (d) => setDoses((x) => [...x, d]);
  const removeDose = (id) => setDoses((x) => x.filter((d) => d.id !== id));
  const upsertSleep = (rec) => setSleep((x) => mergeBy(x, [rec], (r) => r.date));
  const upsertDay = (rec) => setDays((x) => mergeBy(x, [rec], (r) => r.date));
  const addSession = (s) => setManualSessions((x) => [...x, s]);
  const removeSession = (id) => setManualSessions((x) => x.filter((s) => s.id !== id));
  const resetAll = () => { setDoses([]); setSleep([]); setManualSessions([]); setLifts([]); setDays([]); setSettings(DEFAULT_SETTINGS); };
  const goLog = (k) => { setDayKey(k); setTab("log"); };

  const raceDate = settings.race.date ? fromDayKey(settings.race.date) : null;
  const daysOut = raceDate ? Math.ceil((raceDate - new Date()) / 864e5) : null;

  const tabs = [["log", "Log"], ["overview", "Overview"], ["sleep", "Sleep"], ["training", "Training"], ["intake", "Intake"], ["data", "Data"]];

  if (!loaded) {
    return <div className="hl"><style>{CSS}</style><div className="wrap"><p className="note">Opening your log…</p></div></div>;
  }

  return (
    <div className="hl">
      <style>{CSS}</style>
      <div className="wrap">
        <header className="top">
          <div className="brand">Health log <span>· {fromDayKey(toDayKey(new Date())).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</span></div>
          <div className="race">
            {daysOut != null && daysOut >= 0 ? (
              <><b>{daysOut} days</b>to {settings.race.name || "race day"}{settings.race.goalTime ? `, goal ${settings.race.goalTime}` : ""}</>
            ) : <>No race set</>}
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

        {tab === "log" && (
          <Log dayKey={dayKey} setDayKey={setDayKey} doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings}
               addDose={addDose} removeDose={removeDose} upsertSleep={upsertSleep} addSession={addSession} removeSession={removeSession} upsertDay={upsertDay} />
        )}
        {tab === "overview" && <Overview doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} goLog={goLog} />}
        {tab === "sleep" && <SleepDash doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} />}
        {tab === "training" && <TrainingDash sessions={sessions} days={days} settings={settings} setSettings={setSettings} />}
        {tab === "intake" && <IntakeDash doses={doses} sleep={sleep} sessions={sessions} days={days} settings={settings} />}
        {tab === "data" && (
          <Data state={{ doses, sleep, sessions: manualSessions, lifts, days, settings }} setSleep={setSleep} setSessions={setManualSessions}
                setLifts={setLifts} setDoses={setDoses} setDays={setDays} settings={settings} setSettings={setSettings}
                resetAll={resetAll} storageOk={storageOk} />
        )}
      </div>
    </div>
  );
}
