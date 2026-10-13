/* A marathon plan built from your own numbers, not a template.

   Everything here is arithmetic — no model is involved. The shape follows ordinary
   endurance practice: one long run a week, one hard session, easy miles between,
   a cutback every fourth week, a three-week taper, and a cap on how fast weekly
   volume may grow. What it will not do is pretend a goal is realistic when the
   data says otherwise; see assessGoal below. */

import {
  addDays, toDayKey, fromDayKey, lastNDays, mondayOf, round, avg, sum, median,
  toUnit, secsToClock, fmtShort,
} from "./scores.js";

const MARATHON_MI = 26.2;

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
export function paces(goalSeconds) {
  const mp = goalSeconds / MARATHON_MI;
  return {
    marathon: mp,
    easy: mp + 75,
    long: mp + 55,
    steady: mp + 20,
    tempo: mp - 15,          // roughly threshold for a marathoner
    interval: mp - 45,
  };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const DEFAULT_PREFS = {
  intervalDay: 2,          // Tuesday, always
  longRunDays: [0, 6, 5],  // Sunday first, then Saturday, then Friday
  twentyTarget: 3,         // how many 20-milers to fit in
  liftDays: [3, 5],        // Wednesday and Friday
  restDay: 1,              // Monday
  maxJump: 4,              // most a long run may grow beyond anything you have done
};

/* A prior race is a far better predictor than any training run, so it wins when present.
   settings.priorRace = { time: "3:20:00", distanceMi: 26.2, date: "2025-03-09" } */
export function predictFrom(fit, priorRace) {
  const fromTraining = fit.best?.predicted ?? null;
  let fromRace = null;
  if (priorRace?.time) {
    const p = String(priorRace.time).split(":").map(Number);
    const sec = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p.length === 2 ? p[0] * 60 + p[1] : null;
    const mi = Number(priorRace.distanceMi) || MARATHON_MI;
    if (sec) {
      fromRace = riegel(sec, mi, MARATHON_MI);
      // a race more than a year old, with the long runs since gone, is worth less
      if (priorRace.date) {
        const months = (Date.now() - new Date(priorRace.date).getTime()) / (30.44 * 864e5);
        if (months > 12) fromRace *= 1 + Math.min(0.06, (months - 12) * 0.004);
      }
    }
  }
  if (fromRace && fromTraining) return { seconds: Math.min(fromRace, fromTraining * 1.02), basis: "prior race", fromRace, fromTraining };
  if (fromRace) return { seconds: fromRace, basis: "prior race", fromRace, fromTraining };
  if (fromTraining) return { seconds: fromTraining, basis: "best long run", fromRace, fromTraining };
  return { seconds: null, basis: null, fromRace, fromTraining };
}

/* The long-run ladder, built backwards from race day: the last 20 sits three weeks out,
   then they alternate with cutbacks. Falls back gracefully when there is not room. */
export function longRunLadder(weeks, longestRecent, twentyTarget, maxJump = 4) {
  const ladder = new Array(weeks).fill(null);
  const raceWeek = weeks - 1;
  if (weeks >= 3) { ladder[raceWeek - 1] = 8; ladder[raceWeek - 2] = 12; }      // taper
  else if (weeks === 2) ladder[0] = 10;

  // 20s at three, five and seven weeks out, as room allows
  const slots = [raceWeek - 3, raceWeek - 5, raceWeek - 7].filter((i) => i >= 0).slice(0, twentyTarget);
  for (const i of slots) ladder[i] = 20;

  // fill what is left, ramping from where you actually are and cutting back between the 20s
  const start = Math.max(10, Math.min(16, Math.round(longestRecent || 10)));
  for (let i = 0; i < weeks; i++) {
    if (ladder[i] != null) continue;
    const next20 = slots.filter((x) => x > i).sort((a, b) => a - b)[0];
    const prev20 = slots.filter((x) => x < i).sort((a, b) => b - a)[0];
    if (prev20 != null && next20 != null) ladder[i] = 13;                       // cutback between 20s
    else if (next20 != null) {
      const toGo = next20 - i;
      ladder[i] = Math.max(start, Math.round(20 - toGo * 2.5));                 // ramp up to the first 20
    } else ladder[i] = 12;
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
export function buildPlan({ todayKey, startKey, raceDate, raceName, goalSeconds, daily, settings, prefs }) {
  const u = settings.distanceUnit || "mi";
  const P0 = { ...DEFAULT_PREFS, ...(settings.planPrefs || {}), ...(prefs || {}) };
  const fit = assessFitness(daily, settings, todayKey);
  const predicted = predictFrom(fit, settings.priorRace);

  // anchored to the day the plan was started, so past weeks stay on the calendar
  const startMon = mondayOf(startKey && startKey <= todayKey ? startKey : todayKey);
  const days = Math.max(0, Math.round((fromDayKey(raceDate) - fromDayKey(startMon)) / 864e5));
  const weeks = Math.max(1, Math.ceil((days + 1) / 7));
  const P = paces(goalSeconds);

  // the ladder adapts to the longest run you have actually completed recently
  const ladder = longRunLadder(weeks, Math.max(fit.longest, 10), P0.twentyTarget, P0.maxJump ?? 4);
  const twenties = ladder.filter((x) => x >= 20).length;

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
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "race", title: raceName || "Race", miles: MARATHON_MI,
          pace: P.marathon, note: `Goal ${secsToClock(goalSeconds)} — ${secsToClock(P.marathon)}/${u}. Go out at pace, not faster.` });
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
        const set = inTaper ? "4 × 800 m" : w % 3 === 2 ? "5 × 1 mile" : "6 × 800 m";
        const pace = w % 3 === 2 ? P.tempo : P.interval;
        const miles = inTaper ? 5 : w % 3 === 2 ? 9 : 7;
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Intervals", miles, pace,
          note: `${set} at ${secsToClock(pace)}/${u}, equal jog recovery. Two miles warm-up and cool-down either side.` });
      } else if (dow === longDow) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: longMi >= 20 ? "Long run — 20" : "Long run",
          miles: longMi, pace: P.long, flexible: true,
          note: longMi >= 16
            ? `Last ${Math.min(8, Math.round(longMi / 2.5))} ${u} at ${secsToClock(P.marathon)}/${u}. Practise race-day fuelling and kit.`
            : `Steady at ${secsToClock(P.long)}/${u}.` });
      } else if (dow === 3) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Medium-long", miles: inTaper ? 5 : Math.max(6, Math.round(longMi * 0.4)),
          pace: P.steady, note: `Steady, around ${secsToClock(P.steady)}/${u}. Lift afterwards if you have it in you.` });
      } else if (dow === 6) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Marathon-pace run", miles: inTaper ? 4 : 6,
          pace: P.marathon, note: `At ${secsToClock(P.marathon)}/${u}. This is the session that teaches your legs the pace.` });
      } else if (P0.liftDays.includes(dow)) {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "lift", title: dow === 5 ? "Lift — upper" : "Lift — legs",
          note: inTaper ? "Light. Movement, not load." : "Nothing that leaves you sore for the long run." });
      } else {
        weekDays.push({ date, dow: DAY_NAMES[dow], kind: "run", title: "Easy", miles: inTaper ? 3 : 5, pace: P.easy,
          note: `Conversational, around ${secsToClock(P.easy)}/${u}.` });
      }
    }

    out.push({
      week: w + 1, monday, days: weekDays, longMiles: longMi,
      plannedMiles: round(sum(weekDays.map((d) => d.miles || 0)), 1),
      phase: isRaceWeek ? "race" : inTaper ? "taper" : longMi === 20 ? "peak" : longMi <= 13 ? "cutback" : "build",
    });
  }

  const tracked = adherence(out, daily, settings, todayKey);
  const goal = assessGoalV2(fit, predicted, goalSeconds, weeks, twenties, bigJump);
  return { weeks: tracked, fit, goal, predicted, paces: P, raceDate, raceName, goalSeconds, unit: u, prefs: P0, twenties };
}

function assessGoalV2(fit, predicted, goalSeconds, weeks, twenties, bigJump) {
  const notes = [];
  let verdict = "unknown";
  if (predicted.seconds) {
    const gap = (predicted.seconds - goalSeconds) / goalSeconds;
    verdict = gap <= -0.02 ? "comfortable" : gap <= 0.02 ? "realistic" : gap <= 0.06 ? "a stretch" : "ambitious on current form";
    if (predicted.basis === "prior race") {
      notes.push(`Working from your prior race, the equivalent today is about ${secsToClock(predicted.seconds)}.`);
      if (predicted.fromTraining) notes.push(`Your recent training alone would predict ${secsToClock(predicted.fromTraining)}, so the race history is doing the heavy lifting.`);
    } else {
      notes.push(`Predicted from your best long run: about ${secsToClock(predicted.seconds)}.`);
    }
  }
  if (twenties >= 3) notes.push("Three 20-mile runs are in, at seven, five and three weeks out.");
  else if (twenties > 0) {
    notes.push(`Only ${twenties} run${twenties === 1 ? "" : "s"} of 20 fits safely. Long runs are capped at four miles beyond anything you have actually done recently, and that cap bites before the third one.`);
    notes.push("Log a longer run and the plan rebuilds with more of them — it reads your actual history every time you open it.");
  }
  if (bigJump > 2) notes.push(`The first long run is ${round(bigJump, 1)} beyond your recent longest. Build into it and abandon it if something complains.`);
  if (fit.recentWeekly < 30) notes.push(`You have been averaging ${fit.recentWeekly} a week; this plan asks for more. The easy days are what makes that survivable.`);
  return { verdict, notes, goalPace: goalSeconds / MARATHON_MI, predicted: predicted.seconds };
}
