/* A marathon plan built from your own numbers, not a template.

   Everything here is arithmetic — no model is involved. The shape follows ordinary
   endurance practice: one long run a week, one hard session, easy miles between,
   a cutback every fourth week, a three-week taper, and a cap on how fast weekly
   volume may grow. What it will not do is pretend a goal is realistic when the
   data says otherwise; see assessGoal below. */

import {
  addDays, toDayKey, fromDayKey, lastNDays, mondayOf, round, avg, sum, median,
  toUnit, secsToClock, fmtShort, trainingLoad, staminaFrom, staminaWeekly,
} from "./scores.js";

const MARATHON_MI = 26.2;

/* What kind of race, and what that implies for the shape of the training.
   peakLong is the biggest long run; bigTarget is how many of them to fit;
   taperWeeks is how long to back off for. */
export const RACE_TYPES = {
  mile:     { name: "Mile",     miles: 1,      peakLong: 8,  bigTarget: 0, taperWeeks: 1, quality: "track" },
  "5k":     { name: "5K",       miles: 3.107,  peakLong: 10, bigTarget: 0, taperWeeks: 1, quality: "vo2" },
  "10k":    { name: "10K",      miles: 6.214,  peakLong: 12, bigTarget: 0, taperWeeks: 2, quality: "vo2" },
  half:     { name: "Half",     miles: 13.109, peakLong: 16, bigTarget: 2, taperWeeks: 2, quality: "threshold" },
  marathon: { name: "Marathon", miles: 26.2,   peakLong: 20, bigTarget: 3, taperWeeks: 3, quality: "marathon" },
  "50k":    { name: "50K",      miles: 31.07,  peakLong: 24, bigTarget: 3, taperWeeks: 3, quality: "ultra" },
  "50mi":   { name: "50 miles", miles: 50,     peakLong: 30, bigTarget: 3, taperWeeks: 3, quality: "ultra" },
};
export const raceType = (k) => RACE_TYPES[k] || RACE_TYPES.marathon;

/* Seconds from "3:20:38" or "20:30". */
export function parseTime(v) {
  if (!v) return null;
  const p = String(v).trim().split(":").map(Number);
  if (p.some(isNaN)) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return null;
}

/* Best equivalent time for a target distance, from every race you have a result for.
   A race loses a little predictive value as it ages, because the fitness behind it fades. */
export function bestFromRaces(races = [], targetMiles, todayKey) {
  const now = todayKey ? fromDayKey(todayKey) : new Date();
  const all = [];
  for (const r of races) {
    const sec = parseTime(r.resultTime);
    const mi = Number(r.distanceMi) || RACE_TYPES[r.kind]?.miles;
    if (!sec || !mi || !r.date) continue;
    const months = (now - fromDayKey(r.date)) / (30.44 * 864e5);
    if (months < 0) continue;                         // hasn't happened yet
    let pred = riegel(sec, mi, targetMiles);
    // a race fades as the fitness behind it does
    if (months > 6) pred *= 1 + Math.min(0.08, (months - 6) * 0.005);
    all.push({ ...r, seconds: sec, miles: mi, months: round(months, 1), predicted: pred,
      tooShort: mi < targetMiles * 0.35 });
  }
  /* A maximal 5K says what your legs can do for twenty minutes, not for three hours.
     Extrapolating a marathon from one flatters anyone who has not done the long runs,
     so only races of at least about a third of the distance are allowed to predict. */
  const usable = all.filter((r) => !r.tooShort);
  const pool = usable.length ? usable : all;
  const best = pool.reduce((a, b) => (!a || b.predicted < a.predicted ? b : a), null);
  return best ? { ...best, considered: all } : null;
}

/* Riegel: a time over one distance predicts another. The 1.06 exponent is the
   usual value; it flatters people who have not done the long runs, so treat a
   prediction from a short race as optimistic. */
export function riegel(knownSeconds, knownMi, targetMi) {
  if (!knownSeconds || !knownMi || !targetMi) return null;
  return knownSeconds * (targetMi / knownMi) ** 1.06;
}

/* What the log says about where you are now. */
export function assessFitness(daily, settings, todayKey) {
  const u = settings.distanceUnit || "mi";
  const d90 = lastNDays(90, todayKey), d28 = lastNDays(28, todayKey);

  const weekMiles = [];
  for (let w = 0; w < 12; w++) {
    const start = addDays(mondayOf(todayKey), -7 * (w + 1));
    const miles = sum(lastNDays(7, addDays(start, 6)).map((k) => toUnit(daily.get(k).runKm, u)));
    weekMiles.push(round(miles, 1));
  }
  const recentWeekly = round(avg(weekMiles.slice(0, 4).filter((x) => x > 0)) || 0, 1);
  const peakWeekly = Math.max(0, ...weekMiles);

  let longest = 0, longestDate = null;
  for (const k of d90) {
    const mi = toUnit(daily.get(k).runKm, u);
    if (mi > longest) { longest = mi; longestDate = k; }
  }

  const paces = d90.map((k) => daily.get(k).paceSecKm).filter(Boolean);
  const medPaceKm = paces.length ? median(paces) : null;
  const medPace = medPaceKm ? (u === "mi" ? medPaceKm * 1.609344 : medPaceKm) : null;

  // the best single long effort is the most honest predictor available
  let best = null;
  for (const k of d90) {
    const x = daily.get(k);
    const mi = toUnit(x.runKm, u);
    if (mi < 8 || !x.paceSecKm) continue;
    const sec = (u === "mi" ? x.paceSecKm * 1.609344 : x.paceSecKm) * mi;
    const pred = riegel(sec, mi, MARATHON_MI);
    if (!best || pred < best.predicted) best = { date: k, miles: round(mi, 1), seconds: sec, predicted: pred };
  }

  const vo2 = (() => {
    for (const k of [...d90].reverse()) { const v = daily.get(k).sleep?.vo2; if (v != null) return v; }
    return null;
  })();

  const runDays = d28.filter((k) => daily.get(k).hasRun).length;
  const liftDays = d28.filter((k) => daily.get(k).hasLift).length;

  return {
    recentWeekly, peakWeekly, weekMiles, longest: round(longest, 1), longestDate,
    medPace, best, vo2, runDaysPerWeek: round(runDays / 4, 1), liftDaysPerWeek: round(liftDays / 4, 1),
  };
}

/* Everything you have actually run, week by week, for as far back as the log goes.
   This is the raw material the forward plan is bent around. */
export function trainingHistory(daily, settings, todayKey, maxWeeks = 16) {
  const u = settings.distanceUnit || "mi";
  const thisMon = mondayOf(todayKey);
  const out = [];
  for (let w = maxWeeks; w >= 1; w--) {
    const monday = addDays(thisMon, -7 * w);
    const days = lastNDays(7, addDays(monday, 6));
    const runs = days.flatMap((k) => daily.get(k).sessions.filter((s) => s.kind === "run"));
    const miles = sum(days.map((k) => toUnit(daily.get(k).runKm, u)));
    if (!miles && !out.length) continue;                       // skip the empty stretch before you started
    const longest = Math.max(0, ...days.map((k) => toUnit(daily.get(k).runKm, u)));
    const paces = days.map((k) => daily.get(k).paceSecKm).filter(Boolean);
    out.push({
      monday, miles: round(miles, 1), longest: round(longest, 1),
      runs: days.filter((k) => daily.get(k).hasRun).length,
      lifts: days.filter((k) => daily.get(k).hasLift).length,
      quality: runs.filter((r) => ["tempo", "intervals", "race"].includes(r.type)).length,
      pace: paces.length ? round(u === "mi" ? avg(paces) * 1.609344 : avg(paces), 0) : null,
    });
  }
  return out;
}

/* Roughly what a goal of this shape usually asks for in weekly volume.
   Deliberately a range, because the honest answer is a range. */
function volumeFor(T, ambition) {
  const k = { 1: 25, 3.107: 8, 6.214: 5, 13.109: 2.6, 26.2: 1.8, 31.07: 1.6, 50: 1.2 };
  const base = (k[T.miles] ?? 1.8) * T.miles;
  // a goal beyond current form needs more volume; one inside it needs less
  const scale = ambition == null ? 1 : clampNum(1 + ambition * 1.5, 0.8, 1.3);
  return { peak: Math.round(base * scale), floor: Math.round(base * scale * 0.6) };
}
const clampNum = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* The vocabulary the chat is allowed to speak. Anything outside this is ignored,
   and anything inside it is still checked against the rules below before it lands. */
export const ADJUST_OPS = {
  setLong: "set the long run for a given week, in miles",
  setWeekVolume: "set the total mileage for a given week",
  move: "swap the sessions on two dates",
  setIntervalMiles: "change the standard interval session length",
  setIntervalDay: "move interval day (0 Sunday … 6 Saturday)",
  setRestDay: "move the weekly rest day",
  setLongRunDay: "move the weekly long run day",
  setTwentyTarget: "change how many peak long runs to fit",
};

/* The constraints that survive any instruction. These exist because a plan that
   injures you is worse than no plan. */
export function checkAdjustment(a, ctx) {
  const { weeks, T, ladder, volumes, longestRecent, raceWeekIndex, taperStart } = ctx;
  const no = (why) => ({ ok: false, why });
  switch (a.op) {
    case "setLong": {
      const i = Number(a.week) - 1;
      if (!(i >= 0 && i < weeks)) return no(`there is no week ${a.week}`);
      const mi = Number(a.miles);
      if (!(mi > 0)) return no("that is not a distance");
      if (i >= taperStart) return no(`week ${a.week} is in the taper — long runs come down there, they do not go up`);
      const prevMax = Math.max(longestRecent, ...ladder.slice(0, i).filter((x) => x != null));
      if (mi > prevMax + 4) return no(`${mi} is more than four beyond anything before it (${round(prevMax, 1)}); that jump is where injuries come from`);
      if (mi > (volumes[i] ?? 0) * 0.6) return no(`${mi} would be most of that week's ${round(volumes[i], 0)} miles — raise the week first`);
      return { ok: true };
    }
    case "setWeekVolume": {
      const i = Number(a.week) - 1;
      if (!(i >= 0 && i < weeks)) return no(`there is no week ${a.week}`);
      const mi = Number(a.miles);
      if (!(mi > 0)) return no("that is not a distance");
      if (i >= taperStart && mi > (volumes[i] ?? 0) * 1.15) return no("that week is in the taper; raising it defeats the point of tapering");
      const prev = i > 0 ? volumes[i - 1] : null;
      if (prev && mi > prev * 1.15) return no(`that is a ${Math.round(((mi - prev) / prev) * 100)}% jump on the week before; 10% or so is the usual ceiling`);
      return { ok: true };
    }
    case "move": {
      if (!a.from || !a.to) return no("needs two dates");
      return { ok: true };
    }
    case "setIntervalMiles": return Number(a.miles) > 0 && Number(a.miles) <= 20 ? { ok: true } : no("between 1 and 20 miles");
    case "setIntervalDay":
    case "setRestDay":
    case "setLongRunDay": {
      const d = Number(a.dow);
      return d >= 0 && d <= 6 ? { ok: true } : no("day must be 0 to 6");
    }
    case "setTwentyTarget": {
      const n = Number(a.count);
      if (!(n >= 0 && n <= 5)) return no("between 0 and 5");
      return { ok: true };
    }
    default: return no(`"${a.op}" is not something I can change`);
  }
}

/* Past weeks rendered in the same shape as plan weeks, so one calendar can show both.
   These are facts, not prescriptions: whatever you logged is what appears. */
export function historyWeeks(daily, settings, fromKey, toKey) {
  const u = settings.distanceUnit || "mi";
  const out = [];
  for (let monday = mondayOf(fromKey); monday <= toKey; monday = addDays(monday, 7)) {
    const days = [];
    let any = false;
    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      if (date > toKey) break;
      const x = daily.get(date);
      const dow = fromDayKey(date).getDay();
      const miles = round(toUnit(x.runKm, u), 1);
      const runs = x.sessions.filter((r) => r.kind === "run");
      const type = runs.map((r) => r.type).filter(Boolean)[0] || null;
      if (miles || x.hasLift) any = true;
      days.push({
        date, dow: DAY_NAMES[dow], past: true,
        kind: miles ? "run" : x.hasLift ? "lift" : "rest",
        title: miles ? (type ? type[0].toUpperCase() + type.slice(1) : "Run") : x.hasLift ? "Lift" : "—",
        miles: miles || null,
        pace: x.paceSecKm ? (u === "mi" ? x.paceSecKm * 1.609344 : x.paceSecKm) : null,
        sleep: x.sleep?.score ?? null, rhr: x.sleep?.restingHr ?? null,
        drinks: round(x.alc, 1) || 0, thc: round(x.thcMg, 1) || 0,
        note: x.note || "",
      });
    }
    const miles = round(sum(days.map((d) => d.miles || 0)), 1);
    out.push({
      monday, days, past: true, plannedMiles: miles, doneMiles: miles,
      longMiles: Math.max(0, ...days.map((d) => d.miles || 0)) || null,
      phase: "done", any,
    });
  }
  return out;
}

/* Current form, read from the log rather than assumed. */
export function currentForm(daily, settings, todayKey, T, goalSeconds, priorRace, races = []) {
  const u = settings.distanceUnit || "mi";
  const hist = trainingHistory(daily, settings, todayKey, 16);
  const fit = assessFitness(daily, settings, todayKey);
  const { ctl, atl } = trainingLoad(daily, settings, todayKey);
  const fitness = ctl.get(todayKey) ?? ctl.get(addDays(todayKey, -1)) ?? 0;
  const fatigue = atl.get(todayKey) ?? atl.get(addDays(todayKey, -1)) ?? 0;

  const last4 = hist.slice(-4), prior4 = hist.slice(-8, -4);
  const recent = round(avg(last4.map((h) => h.miles)) || 0, 1);
  const before = round(avg(prior4.map((h) => h.miles)) || 0, 1);
  const trend = before ? round(((recent - before) / before) * 100, 0) : null;
  const consistency = hist.length ? round((hist.slice(-8).filter((h) => h.miles > 0).length / Math.min(8, hist.length)) * 100, 0) : null;

  const predicted = predictFrom(fit, priorRace, T.miles, races, todayKey);
  const ambition = predicted.seconds && goalSeconds ? (predicted.seconds - goalSeconds) / goalSeconds : null;
  const need = volumeFor(T, ambition);

  return {
    hist, fit, recentWeekly: recent, priorWeekly: before, trend, consistency,
    fitness: round(fitness, 2), fatigue: round(fatigue, 2),
    freshness: fitness > 0 ? round(((fitness - fatigue) / fitness) * 100, 0) : null,
    stamina: round(staminaFrom(fitness), 0),
    staminaWeekly: round(staminaWeekly(fitness), 1),
    longest: fit.longest, predicted, ambition, need,
    gap: round(need.peak - recent, 1),
  };
}

/* An honest read on the goal, before any plan is drawn. */
export function assessGoal(fit, goalSeconds, weeksOut) {
  const notes = [];
  const goalPace = goalSeconds / MARATHON_MI;
  const predicted = fit.best?.predicted ?? null;

  let verdict = "unknown";
  if (predicted) {
    const gap = (predicted - goalSeconds) / goalSeconds;
    verdict = gap <= -0.02 ? "comfortable" : gap <= 0.03 ? "realistic" : gap <= 0.10 ? "a stretch" : "out of reach on current form";
    notes.push(`Your best long run — ${fit.best.miles} ${"mi"} on ${fmtShort(fit.best.date)} — projects to about ${secsToClock(predicted)} over the full distance.`);
    if (gap > 0.03) notes.push(`That is ${secsToClock(Math.abs(predicted - goalSeconds))} slower than the goal.`);
  } else {
    notes.push("No run of eight miles or more with a pace attached in the last 90 days, so there is nothing solid to predict from.");
  }

  // the two things that actually injure people on a short runway
  if (fit.longest < 16) {
    notes.push(`Your longest run in 90 days is ${fit.longest} mi. A marathon wants at least one run of 18 to 20 before the taper.`);
  }
  if (fit.recentWeekly < 25) {
    notes.push(`You have been averaging ${fit.recentWeekly} mi a week. Marathon plans usually peak at two to three times that.`);
  }
  if (weeksOut < 12) {
    notes.push(`${weeksOut} weeks is a short runway — enough to sharpen existing fitness, not enough to build much new.`);
  }
  return { verdict, goalPace, predicted, notes };
}

/* Training paces, derived from the goal rather than from a chart. */
export function paces(goalSeconds, raceMiles = MARATHON_MI) {
  // Convert the goal to its marathon equivalent first, so the usual offsets apply
  // whether the race is a mile or fifty of them.
  const mpEquiv = riegel(goalSeconds, raceMiles, MARATHON_MI) / MARATHON_MI;
  return {
    race: goalSeconds / raceMiles,
    marathon: mpEquiv,
    easy: mpEquiv + 75,
    long: mpEquiv + 55,
    steady: mpEquiv + 20,
    tempo: mpEquiv - 15,     // roughly threshold
    interval: mpEquiv - 45,
    rep: mpEquiv - 75,       // faster than threshold, for the short stuff
  };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const DEFAULT_PREFS = {
  intervalDay: 2,          // Tuesday, always
  longRunDays: [0, 6, 5],  // Sunday first, then Saturday, then Friday
  twentyTarget: null,      // how many peak long runs; null means "whatever the race needs"
  liftDays: [3, 5],        // Wednesday and Friday
  restDay: 1,              // Monday
  maxJump: 4,              // most a long run may grow beyond anything you have done
  intervalMiles: 4,        // total for a session including warm-up and cool-down
  historyMonths: 6,        // how far back the calendar reaches
};

/* A prior race is a far better predictor than any training run, so it wins when present.
   settings.priorRace = { time: "3:20:00", distanceMi: 26.2, date: "2025-03-09" } */
export function predictFrom(fit, priorRace, targetMiles = MARATHON_MI, races = [], todayKey = null) {
  const fromTraining = fit.best ? riegel(fit.best.seconds, fit.best.miles, targetMiles) : null;
  let fromRace = null;
  if (priorRace?.time) {
    const p = String(priorRace.time).split(":").map(Number);
    const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : null;
    const mi = Number(priorRace.distanceMi) || MARATHON_MI;
    if (sec) {
      fromRace = riegel(sec, mi, targetMiles);
      // a race more than a year old, with the long runs since gone, is worth less
      if (priorRace.date) {
        const months = (Date.now() - new Date(priorRace.date).getTime()) / (30.44 * 864e5);
        if (months > 12) fromRace *= 1 + Math.min(0.06, (months - 12) * 0.004);
      }
    }
  }
  // a logged race result beats both
  const r = bestFromRaces(races, targetMiles, todayKey);
  if (r) {
    return { seconds: fromTraining ? Math.min(r.predicted, fromTraining * 1.03) : r.predicted,
      basis: `${r.name || "your race"} on ${r.date}`, fromRace: r.predicted, fromTraining, race: r };
  }
  if (fromRace && fromTraining) return { seconds: Math.min(fromRace, fromTraining * 1.02), basis: "prior race", fromRace, fromTraining };
  if (fromRace) return { seconds: fromRace, basis: "prior race", fromRace, fromTraining };
  if (fromTraining) return { seconds: fromTraining, basis: "best long run", fromRace, fromTraining };
  return { seconds: null, basis: null, fromRace, fromTraining };
}

/* The long-run ladder, built backwards from race day: the last 20 sits three weeks out,
   then they alternate with cutbacks. Falls back gracefully when there is not room. */
export function longRunLadder(weeks, longestRecent, twentyTarget, maxJump = 4, peakLong = 20, taperWeeks = 3) {
  const ladder = new Array(weeks).fill(null);
  const raceWeek = weeks - 1;
  // taper: long runs shrink over the final weeks
  // closest to the race is the smallest, so the fractions rise as we step back
  const taperLongs = [peakLong * 0.4, peakLong * 0.6, peakLong * 0.75].slice(0, Math.max(0, taperWeeks - 1));
  taperLongs.forEach((v, n) => { const i = raceWeek - 1 - n; if (i >= 0) ladder[i] = Math.round(v); });

  // the big ones, spaced two weeks apart, the last three weeks out
  const firstSlot = raceWeek - Math.max(2, taperWeeks);
  const slots = [];
  for (let n = 0; n < twentyTarget; n++) { const i = firstSlot - n * 2; if (i >= 0) slots.push(i); }
  for (const i of slots) ladder[i] = peakLong;

  // fill what is left, ramping from where you actually are and cutting back between the 20s
  const start = Math.round(Math.max(Math.min(6, peakLong * 0.4), Math.min(peakLong * 0.8, longestRecent || 6)));
  for (let i = 0; i < weeks; i++) {
    if (ladder[i] != null) continue;
    const next20 = slots.filter((x) => x > i).sort((a, b) => a - b)[0];
    const prev20 = slots.filter((x) => x < i).sort((a, b) => b - a)[0];
    if (prev20 != null && next20 != null) ladder[i] = Math.round(peakLong * 0.65);   // cutback between the big ones
    else if (next20 != null) {
      const toGo = next20 - i;
      ladder[i] = Math.max(start, Math.round(peakLong - toGo * Math.max(2, peakLong * 0.12)));
    } else ladder[i] = Math.round(peakLong * 0.6);
  }
  ladder[raceWeek] = null;                                                      // race week

  // Safety pass: no long run may be more than maxJump beyond the longest you have
  // actually done, or beyond the previous long run. This is where injuries come from,
  // so it overrides the target number of 20s.
  let reachable = Math.max(8, longestRecent || 8);
  for (let i = 0; i < weeks; i++) {
    if (ladder[i] == null) continue;
    const cap = reachable + maxJump;
    if (ladder[i] > cap) ladder[i] = Math.round(cap);
    reachable = Math.max(reachable, ladder[i]);
  }
  return ladder;
}

/* How much of the plan you actually did, week by week. This is what makes the next
   week adapt rather than repeat a fantasy. */
export function adherence(weeks, daily, settings, todayKey) {
  const u = settings.distanceUnit || "mi";
  return weeks.map((w) => {
    const past = w.days.filter((d) => d.date < todayKey);
    if (!past.length) return { ...w, status: "ahead", doneMiles: null, plannedSoFar: null, hit: null };
    let done = 0, planned = 0, longestDone = 0, sessionsDone = 0, sessionsPlanned = 0;
    const marks = {};
    for (const d of past) {
      const x = daily.get(d.date);
      const actual = toUnit(x.runKm, u);
      done += actual; planned += d.miles || 0;
      if (actual > longestDone) longestDone = actual;
      if (d.kind === "run" || d.kind === "race") {
        sessionsPlanned++;
        if (x.hasRun) sessionsDone++;
      }
      marks[d.date] = {
        ran: x.hasRun, lifted: x.hasLift, actualMiles: round(actual, 1),
        pace: x.paceSecKm ? (u === "mi" ? x.paceSecKm * 1.609344 : x.paceSecKm) : null,
        verdict: d.kind === "rest" ? (x.hasRun ? "extra" : "as planned")
          : d.kind === "lift" ? (x.hasLift ? "done" : x.hasRun ? "ran instead" : "missed")
          : !x.hasRun ? "missed"
          : d.miles && actual >= d.miles * 0.85 ? "done"
          : d.miles && actual >= d.miles * 0.5 ? "short" : "done",
      };
    }
    return {
      ...w, marks,
      doneMiles: round(done, 1), plannedSoFar: round(planned, 1),
      longestDone: round(longestDone, 1),
      hit: planned > 0 ? round((done / planned) * 100, 0) : null,
      sessionsDone, sessionsPlanned,
      status: w.days.every((d) => d.date < todayKey) ? "done" : "current",
    };
  });
}

/**
 * The plan. Rebuilt from the log every time it is read, so missed weeks change what follows.
 */
export function buildPlan({ todayKey, startKey, raceDate, raceName, raceKind, goalSeconds, daily, settings, prefs }) {
  const u = settings.distanceUnit || "mi";
  const T = raceType(raceKind || settings.race?.kind || "marathon");
  const P0 = { ...DEFAULT_PREFS, ...(settings.planPrefs || {}), ...(prefs || {}) };
  if (P0.twentyTarget == null || P0.twentyTarget === "") P0.twentyTarget = T.bigTarget;
  const form = currentForm(daily, settings, todayKey, T, goalSeconds, settings.priorRace, settings.races || []);
  const fit = form.fit;
  const predicted = form.predicted;

  // forward from this week; the past is read as history rather than replayed as a plan
  const startMon = mondayOf(todayKey);
  const days = Math.max(0, Math.round((fromDayKey(raceDate) - fromDayKey(startMon)) / 864e5));
  const weeks = Math.max(1, Math.ceil((days + 1) / 7));
  const P = paces(goalSeconds, T.miles);

  // the ladder adapts to the longest run you have actually completed recently
  const ladderRaw = longRunLadder(weeks, Math.max(fit.longest, Math.min(6, T.peakLong * 0.4)),
    P0.twentyTarget ?? T.bigTarget, P0.maxJump ?? 4, T.peakLong, T.taperWeeks);

  /* Weekly volume: start from where you actually are, aim at what the goal usually needs,
     and never grow faster than 8% a week. If the gap is too big to close safely, the plan
     gets as close as it can and says so rather than prescribing an injury. */
  const buildWeeks = Math.max(1, weeks - T.taperWeeks);
  let from = Math.max(form.recentWeekly || T.miles * 0.5, T.miles * 0.4);
  // deep fatigue right now means the first weeks start below where you have been
  if (form.freshness != null && form.freshness <= -15) from *= 0.85;
  const want = form.need.peak;
  /* The ramp keeps climbing underneath; a cutback week dips below it rather than
     resetting it. Getting this wrong keeps the plan permanently small, which in turn
     keeps the long runs small, because a long run may not dominate its week. */
  const volumes = [];
  let base = from;
  for (let i = 0; i < buildWeeks; i++) {
    base = Math.min(want, base * 1.08);
    const cutback = i > 0 && (i + 1) % 4 === 0;
    volumes.push(cutback ? base * 0.8 : base);
  }
  const reachedPeak = Math.max(...volumes, from);
  // descending through the taper: the week before the race is the smallest
  const taperShape = [0.75, 0.55, 0.4].slice(3 - T.taperWeeks);
  for (const f of taperShape) volumes.push(reachedPeak * f);

  // a long run should not be more than about 55% of the week it sits in
  // Higdon runs a 20 inside a 40-mile week, so the long run may take a bigger share
  // than I first allowed. Short-race training keeps the smaller share, where volume is the point.
  const longShare = T.miles >= 13 ? 0.62 : 0.5;
  let ladder = ladderRaw.map((x, i) => (x == null ? null : Math.min(x, Math.max(6, Math.round((volumes[i] ?? from) * longShare)))));

  /* Adjustments asked for in the chat. Each is checked before it lands; anything
     refused comes back with a reason so the chat can say why. */
  const adjustments = settings.planAdjust || [];
  const applied = [], rejected = [];
  const taperStart = weeks - T.taperWeeks;
  for (const a of adjustments) {
    const ctx = { weeks, T, ladder, volumes, longestRecent: Math.max(fit.longest, 8), raceWeekIndex: weeks - 1, taperStart };
    const v = checkAdjustment(a, ctx);
    if (!v.ok) { rejected.push({ ...a, why: v.why }); continue; }
    switch (a.op) {
      case "setLong": ladder[Number(a.week) - 1] = Number(a.miles); break;
      case "setWeekVolume": volumes[Number(a.week) - 1] = Number(a.miles); break;
      case "setIntervalMiles": P0.intervalMiles = Number(a.miles); break;
      case "setIntervalDay": P0.intervalDay = Number(a.dow); break;
      case "setRestDay": P0.restDay = Number(a.dow); break;
      case "setLongRunDay": P0.longRunDays = [Number(a.dow), ...[0, 6, 5].filter((x) => x !== Number(a.dow))]; break;
      case "setTwentyTarget": P0.twentyTarget = Number(a.count); break;
      default: break;
    }
    applied.push(a);
  }
  // a change to the shape means the ladder is rebuilt around it
  if (applied.some((a) => ["setTwentyTarget"].includes(a.op))) {
    const re = longRunLadder(weeks, Math.max(fit.longest, Math.min(6, T.peakLong * 0.4)),
      P0.twentyTarget ?? T.bigTarget, P0.maxJump ?? 4, T.peakLong, T.taperWeeks);
    ladder = re.map((x, i) => (x == null ? null : Math.min(x, Math.max(6, Math.round((volumes[i] ?? from) * 0.55)))));
    for (const a of applied.filter((a) => a.op === "setLong")) ladder[Number(a.week) - 1] = Number(a.miles);
  }
  const twenties = ladder.filter((x) => x >= T.peakLong).length;

  // a jump of more than about 4 miles over your current longest is where injuries live
  const firstLong = ladder.find((x) => x != null) || 0;
  const bigJump = firstLong - fit.longest;

  const raceDow = fromDayKey(raceDate).getDay();
  const longDow = P0.longRunDays[0];

  const out = [];
  for (let w = 0; w < weeks; w++) {
    const monday = addDays(startMon, w * 7);
    const isRaceWeek = w === weeks - 1;
    const longMi = ladder[w];
    const inTaper = longMi != null && longMi <= 12 && w >= weeks - 3;
    const weekDays = [];

    for (let d = 0; d < 7; d++) {
      const date = addDays(monday, d);
      if (date > raceDate) continue;
      const dow = fromDayKey(date).getDay();

      if (date === raceDate) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "race", title: raceName || T.name, miles: round(T.miles, 1),
          pace: P.race, note: `${T.name} · goal ${secsToClock(goalSeconds)} — ${secsToClock(P.race)}/${u}. Go out at pace, not faster.` });
        continue;
      }
      if (isRaceWeek) {
        const toGo = Math.round((fromDayKey(raceDate) - fromDayKey(date)) / 864e5);
        if (toGo === 4) weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Easy with strides", miles: 4, pace: P.easy, note: "Six × 20 s strides at the end." });
        else if (toGo === 2) weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Shake-out", miles: 3, pace: P.easy, note: "Twenty minutes, legs turning over." });
        else weekDays.push({ date, dow: DAY_NAMES[dow], kind: "rest", title: "Rest", note: toGo === 1 ? "Off your feet. Eat normally, drink more than feels necessary." : "" });
        continue;
      }

      if (dow === P0.restDay) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "rest", title: "Rest", note: "Complete day off." });
      } else if (dow === P0.intervalDay) {
        // short races want short and fast; long ones want sustained
        // sized to what you actually do: the session total, warm-up and cool-down included
        const total = P0.intervalMiles || 4;
        const work = Math.max(1, round(total - 2, 1));          // a mile each side
        const reps = (d, each) => Math.max(3, Math.round((work * 1609) / d));
        const menu = {
          track:     [[`${reps(400)} × 400 m`, P.rep], [`${reps(600)} × 600 m`, P.rep], [`${reps(200)} × 200 m`, P.rep]],
          vo2:       [[`${reps(800)} × 800 m`, P.interval], [`${reps(1000)} × 1000 m`, P.interval], [`${reps(400)} × 400 m`, P.rep]],
          threshold: [[`${Math.max(2, Math.round(work))} × 1 mile`, P.tempo], [`${reps(800)} × 800 m`, P.interval], [`${Math.round(work * 8)} min tempo`, P.tempo]],
          marathon:  [[`${reps(800)} × 800 m`, P.interval], [`${Math.max(2, Math.round(work))} × 1 mile`, P.tempo], [`${Math.max(2, Math.round(work / 2))} × 2 mile`, P.tempo]],
          ultra:     [[`${Math.max(2, Math.round(work))} × 1 mile`, P.tempo], [`${Math.round(work * 8)} min tempo`, P.tempo], [`${reps(800)} × 800 m`, P.interval]],
        }[T.quality] || [[`${reps(800)} × 800 m`, P.interval]];
        const [set, pace] = menu[w % menu.length];
        const miles = inTaper ? Math.max(3, round(total * 0.7, 1)) : total;
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Intervals", miles, pace,
          note: `${set} at ${secsToClock(pace)}/${u}, equal jog recovery. A mile warm-up and cool-down either side — ${miles} ${u} in total.` });
      } else if (dow === longDow) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: longMi >= T.peakLong ? `Long run — ${T.peakLong}` : "Long run",
          miles: longMi, pace: P.long, flexible: true,
          note: longMi >= T.peakLong * 0.7 && T.miles >= 13
            ? `Last ${Math.min(8, Math.round(longMi / 2.5))} ${u} at ${secsToClock(P.race)}/${u}. Practise race-day fuelling and kit.`
            : `Steady at ${secsToClock(P.long)}/${u}.` });
      } else if (dow === 3) {
        const room = (volumes[w] ?? from) - (longMi || 0);
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Medium-long",
          miles: inTaper ? 5 : Math.max(3, Math.min(Math.round(longMi * 0.4), Math.round(room * 0.35))),
          pace: P.steady, note: `Steady, around ${secsToClock(P.steady)}/${u}. Lift afterwards if you have it in you.` });
      } else if (dow === 6 && (volumes[w] ?? from) < (longMi || 0) + 12) {
        // at low volume there is no room for an extra quality day
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "rest", title: "Rest", note: "The long run is doing the work this week." });
      } else if (dow === 6) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Race-pace run", miles: inTaper ? 4 : Math.max(3, Math.min(8, Math.round(T.miles * 0.25))),
          pace: P.race, note: `At ${secsToClock(P.race)}/${u}. This is the session that teaches your legs the pace.` });
      } else if (P0.liftDays.includes(dow)) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "lift", title: dow === 5 ? "Lift — upper" : "Lift — legs",
          note: inTaper ? "Light. Movement, not load." : "Nothing that leaves you sore for the long run." });
      } else {
        // whatever is left of the week's volume, spread across the easy days
        const target = volumes[w] ?? from;
        const spoken = (longMi || 0) + (inTaper ? 9 : 16);        // intervals, medium-long, race-pace
        const easyEach = Math.max(2, Math.min(8, Math.round((target - spoken) / 2)));
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Easy", miles: inTaper ? 3 : easyEach, pace: P.easy,
          note: `Conversational, around ${secsToClock(P.easy)}/${u}.` });
      }
    }

    // the long run and the quality session are fixed; the rest flexes so the week
    // lands near its target instead of drifting above it
    const target = volumes[w] ?? from;
    const flex = weekDays.filter((d) => d.kind === "run" && d.miles && !["race"].includes(d.kind)
      && d.title !== "Long run" && !d.title.startsWith("Long run") && d.title !== "Intervals");
    let planned = sum(weekDays.map((d) => d.miles || 0));
    if (!isRaceWeek && flex.length && planned > target * 1.05) {
      const excess = planned - target;
      const pool = sum(flex.map((d) => d.miles));
      for (const d of flex) d.miles = Math.max(3, round(d.miles - excess * (d.miles / pool), 1));
      planned = sum(weekDays.map((d) => d.miles || 0));
    }

    out.push({
      week: w + 1, monday, days: weekDays, longMiles: longMi,
      plannedMiles: round(planned, 1),
      targetMiles: round(target, 1),
        phase: isRaceWeek ? "race" : inTaper ? "taper" : longMi >= T.peakLong ? "peak" : longMi <= T.peakLong * 0.7 ? "cutback" : "build",
    });
  }

  // anything dragged to another day, applied after the plan is drawn
  const swaps = [...(settings.planSwaps || []), ...applied.filter((a) => a.op === "move").map((a) => [a.from, a.to])];
  if (swaps.length) {
    const byDate = new Map();
    for (const w of out) for (const d of w.days) byDate.set(d.date, d);
    for (const [from, to] of swaps) {
      const a = byDate.get(from), b = byDate.get(to);
      if (!a || !b || a.kind === "race" || b.kind === "race") continue;
      const keep = ["kind", "title", "miles", "pace", "note", "flexible"];
      const tmp = Object.fromEntries(keep.map((k) => [k, a[k]]));
      for (const k of keep) a[k] = b[k];
      for (const k of keep) b[k] = tmp[k];
      a.moved = true; b.moved = true;
    }
    for (const w of out) w.plannedMiles = round(sum(w.days.map((d) => d.miles || 0)), 1);
  }

  const tracked = adherence(out, daily, settings, todayKey);
  const goal = assessGoalV2(fit, predicted, goalSeconds, weeks, twenties, bigJump, T, form, reachedPeak);
  const months = P0.historyMonths ?? 6;
  const historyFrom = toDayKey(new Date(fromDayKey(raceDate).getTime() - months * 30.44 * 864e5));
  const past = historyWeeks(daily, settings, historyFrom, addDays(startMon, -1));

  return { weeks: tracked, past, fit, form, goal, predicted, paces: P, raceDate, raceName, goalSeconds,
    unit: u, prefs: P0, twenties, type: T, history: form.hist, applied, rejected, taperStart };
}

function assessGoalV2(fit, predicted, goalSeconds, weeks, twenties, bigJump, T, form, reachedPeak) {
  const notes = [];
  let verdict = "unknown";
  if (predicted.seconds) {
    const gap = (predicted.seconds - goalSeconds) / goalSeconds;
    verdict = gap <= -0.02 ? "comfortable" : gap <= 0.02 ? "realistic" : gap <= 0.06 ? "a stretch" : "ambitious on current form";
    if (predicted.race) {
      notes.push(`From ${predicted.race.name || "your race"} (${predicted.race.resultTime} over ${round(predicted.race.miles, 1)}, ${predicted.race.months} months ago), the equivalent today is about ${secsToClock(predicted.seconds)}.`);
      if (predicted.fromTraining) notes.push(`Your recent training alone would predict ${secsToClock(predicted.fromTraining)}, so the race history is doing the heavy lifting.`);
    } else {
      notes.push(`Predicted from your best long run: about ${secsToClock(predicted.seconds)}.`);
    }
  }
  const want = T.bigTarget;
  if (want > 0) {
    if (twenties >= want) notes.push(`${twenties} run${twenties === 1 ? "" : "s"} of ${T.peakLong} are in, spaced two weeks apart with the last three weeks out.`);
    else {
      notes.push(`Only ${twenties} of the ${want} runs at ${T.peakLong} fits safely. Long runs are capped at four beyond anything you have actually done recently, and that cap bites first.`);
      notes.push("Log a longer run and the plan rebuilds with more of them — it reads your history every time you open it.");
    }
  }
  if (bigJump > 2) notes.push(`The first long run is ${round(bigJump, 1)} beyond your recent longest. Build into it and abandon it if something complains.`);
  // what the volume ramp can actually reach, versus what the goal usually wants
  if (form && reachedPeak) {
    const want = form.need.peak;
    if (reachedPeak < want * 0.85) {
      notes.push(`This goal usually wants around ${want} a week at peak. From ${form.recentWeekly} now, growing no more than 8% a week, the plan tops out near ${Math.round(reachedPeak)} — enough to race well, short of ideal.`);
    } else {
      notes.push(`The plan climbs from ${form.recentWeekly} to about ${Math.round(reachedPeak)} a week at peak, which is roughly what this goal asks for.`);
    }
    if (form.trend != null && Math.abs(form.trend) >= 15) {
      notes.push(form.trend > 0
        ? `Your volume is already up ${form.trend}% on the previous month, so the ramp here is gentler than it looks.`
        : `Your volume is down ${Math.abs(form.trend)}% on the previous month; the plan rebuilds from where you are now, not where you were.`);
    }
    if (form.freshness != null && form.freshness <= -15) {
      notes.push(`You are carrying real fatigue right now (${form.freshness}%). The first week is deliberately modest.`);
    }
  }
  return { verdict, notes, goalPace: goalSeconds / T.miles, predicted: predicted.seconds };
}
