/* Scoring and rollups, shared by the browser app and the scheduled daily brief.
   One copy means a change to Degen can never apply in only one place. */

export const pad = (n) => String(n).padStart(2, "0");
export const KM_PER_MI = 1.609344;
export const toUnit = (km, u) => (u === "mi" ? km / KM_PER_MI : km);
export const fromUnit = (v, u) => (u === "mi" ? v * KM_PER_MI : v);
export const round = (n, d = 1) => (n == null || isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
export const sum = (arr) => arr.reduce((a, b) => a + b, 0);

export function toDayKey(d) {
  const x = d instanceof Date ? d : new Date(d);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;
}

export function fromDayKey(k) { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); }

export function addDays(k, n) { const d = fromDayKey(k); d.setDate(d.getDate() + n); return toDayKey(d); }

export function mondayOf(k) {
  const d = fromDayKey(k);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return toDayKey(d);
}

export function dayKeyFor(ts, dayStartHour) {
  return toDayKey(new Date(new Date(ts).getTime() - dayStartHour * 3600e3));
}

export function lastNDays(n, endKey) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(endKey, -i));
  return out;
}

export function minsToHM(m) {
  if (m == null || isNaN(m)) return "—";
  return `${Math.floor(m / 60)}h ${pad(Math.round(m % 60))}m`;
}

export function secsToClock(s) {
  if (s == null || isNaN(s) || !isFinite(s)) return "—";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.round(s % 60);
  return h > 0 ? `${h}:${pad(m)}:${pad(x)}` : `${m}:${pad(x)}`;
}

export function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* Linear interpolation into a sorted list, for percentiles. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const i = Math.floor(pos), frac = pos - i;
  return i + 1 < sorted.length ? sorted[i] + frac * (sorted[i + 1] - sorted[i]) : sorted[i];
}

/* Where a value sits in its own window: median = 50, with the ends pinned to the
   5th and 95th percentiles rather than the single best and worst day, so one outlier
   cannot flatten everything else. Beyond those ends the index simply saturates. */
export function relToMedian(v, arr) {
  if (v == null || arr.length < 3) return null;
  const s = [...arr].sort((a, b) => a - b);
  const med = median(s), lo = quantile(s, 0.05), hi = quantile(s, 0.95);
  if (v >= med) return hi <= med ? 50 : clamp(50 + (50 * (v - med)) / (hi - med), 0, 100);
  return med <= lo ? 50 : clamp((50 * (v - lo)) / (med - lo), 0, 100);
}

export function pearson(xs, ys) {
  const n = xs.length; if (n < 4) return null;
  const mx = avg(xs), my = avg(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

/* pace of a session in the current unit: from time+distance if both exist, else from a stored pace */
export function paceSecOf(s, unit) {
  if (s.movingSec && s.distanceKm) return s.movingSec / toUnit(s.distanceKm, unit);
  if (s.paceSecPerKm) return unit === "mi" ? s.paceSecPerKm * KM_PER_MI : s.paceSecPerKm;
  return null;
}

export function fmtShort(k) {
  return fromDayKey(k).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function fmtDayLabel(k) {
  return fromDayKey(k).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

/* ---- the three indices ---- */

// yesterday counts half, then it fades: 5/10, 3/10, 1.5/10, 0.5/10
export const LAG_W = [0.5, 0.3, 0.15, 0.05];

// Regen: how well you have been sleeping. Garmin's score, or hours against your goal if there's no score.
export function regenRaw(x, settings) {
  const s = x.sleep;
  if (!s) return null;
  if (s.score != null) return clamp(s.score, 0, 100);
  if (s.asleepMin != null) return clamp((s.asleepMin / 60 / settings.sleepHoursGoal) * 85, 0, 100);
  return null;
}

/* Training load, the way endurance coaches model it.

   Each day gets a load figure from distance and how fast it was relative to your own
   median pace. Two exponentially weighted averages run over those: a slow one (42 days)
   is fitness, a fast one (7 days) is fatigue. Stamina is the slow one, so a rest day
   stops the clock rather than zeroing the score, and Freshness is fitness minus fatigue.

   Because it is already smoothed over weeks, Stamina is not passed through the four-day
   lag weighting that Regen and Degen use. */
export function trainingLoad(daily, settings, until) {
  const keys = [...daily.byDay.keys()].sort();
  const ctl = new Map(), atl = new Map();
  if (!keys.length) return { ctl, atl, medPace: null };

  const u = settings.distanceUnit || "mi";
  const paces = keys.map((k) => daily.get(k).paceSecKm).filter(Boolean);
  const medPace = paces.length ? median(paces) : null;

  const end = until && until > keys[keys.length - 1] ? until : keys[keys.length - 1];
  let c = 0, a = 0;
  for (let k = keys[0]; k <= end; k = addDays(k, 1)) {
    const x = daily.get(k);
    const dist = toUnit(x.runKm || 0, u);
    // a faster-than-usual mile counts for more than an easy one, within reason
    const factor = dist && x.paceSecKm && medPace ? clamp((medPace / x.paceSecKm) ** 2, 0.7, 1.6) : 1;
    const load = dist * factor;
    c += (load - c) / 42;
    a += (load - a) / 7;
    ctl.set(k, c); atl.set(k, a);
  }
  return { ctl, atl, medPace };
}

/* Fitness expressed against your own weekly target: hitting the target lands near 70,
   so there is headroom above it and the number means something on its own. */
export function staminaFrom(ctlValue, settings) {
  if (ctlValue == null) return null;
  const perDay = (settings.weeklyDistanceTarget || 40) / 7;
  if (!perDay) return null;
  return clamp((ctlValue / perDay) * 70, 0, 100);
}

export function degenRaw(x) {
  const drinks = x.alc || 0, thc = x.thcMg || 0, sess = x.thcSessions || 0, nic = x.nicMg || 0, stim = x.stimMg || 0, cof = x.cafCount || 0;
  let s = 4 * cof + 6 * drinks + 3 * thc + 8 * sess + 1 * nic + 3 * stim;
  const heavyDrink = drinks > 4.5;
  const heavyWeed = thc > 5 || sess >= 2;
  if (heavyDrink) s += 40 + 10 * (drinks - 4.5);
  if (heavyWeed) s += 30 + 3 * Math.max(0, thc - 5);
  if (heavyDrink && heavyWeed) s *= 1.25;
  return clamp(s, 0, 100);
}

// Rolling value for a day: the four days before it, weighted. Missing sleep is skipped and the weights
// renormalised; a day with no run or no intake logged counts as zero, because that is what it was.
export function lagged(rawByDate, dayKey, missingAsZero) {
  let num = 0, den = 0;
  LAG_W.forEach((w, i) => {
    const v = rawByDate.get(addDays(dayKey, -(i + 1)));
    if (v == null) { if (missingAsZero) den += w; return; }
    num += v * w; den += w;
  });
  return den ? num / den : null;
}

export function buildIndices(daily, dayKeys, settings) {
  const first = dayKeys[0];
  const ext = [...lastNDays(4, addDays(first, -1)), ...dayKeys];
  const { ctl, atl } = trainingLoad(daily, settings, dayKeys[dayKeys.length - 1]);

  const regen = new Map(), degen = new Map();
  for (const k of ext) {
    const x = daily.get(k);
    regen.set(k, regenRaw(x, settings));
    degen.set(k, degenRaw(x));
  }
  return dayKeys.map((k) => {
    // read yesterday's fitness, so all three scores look backwards the same way
    const y = addDays(k, -1);
    const c = ctl.has(y) ? ctl.get(y) : ctl.get(k);
    const f = atl.has(y) ? atl.get(y) : atl.get(k);
    return {
      date: k, label: fmtShort(k),
      regen: round(lagged(regen, k, false), 1),
      run: c == null ? null : round(staminaFrom(c, settings), 1),
      degen: round(lagged(degen, k, true), 1),
      fitness: c == null ? null : round(c, 2),
      fatigue: f == null ? null : round(f, 2),
      // as a share of your fitness: negative means carrying fatigue, positive means rested
      freshness: c > 0 && f != null ? round(((c - f) / c) * 100, 1) : null,
    };
  });
}

/* ---- daily rollup ---- */

/* Fold every log entry into one object per day. Pure, so the server can call it too. */
export function rollup({ doses = [], sleep = [], sessions = [], days = [], settings }) {
  const dayStartHour = settings?.dayStartHour ?? 4;
  const byDay = new Map();
  const blank = (k) => ({ date: k, sleep: null, sessions: [], caf: 0, cafCount: 0, alc: 0, thc: 0, thcMg: 0,
    thcSessions: 0, nic: 0, nicMg: 0, stim: 0, stimMg: 0, entries: [], tags: [], note: "", steps: null });
  const day = (k) => { if (!byDay.has(k)) byDay.set(k, blank(k)); return byDay.get(k); };

  for (const s of sleep) {
    if (s.score != null || s.asleepMin != null || s.restingHr != null || s.bodyBattery != null || s.bedtime || s.vo2 != null) day(s.date).sleep = s;
  }
  for (const d of days) { const x = day(d.date); x.tags = d.tags || []; x.note = d.note || ""; x.steps = d.steps ?? null; }
  for (const s of sessions) day(s.date).sessions.push(s);
  for (const d of doses) {
    const k = dayKeyFor(d.ts, dayStartHour); const x = day(k);
    x.entries.push(d);
    if (d.kind === "caffeine") { x.caf += d.amount; x.cafCount += 1; }
    else if (d.kind === "alcohol") x.alc += d.amount;
    else if (d.kind === "cannabis") { x.thc += 1; if (d.unit === "mg") x.thcMg += d.amount; else x.thcSessions += d.amount; }
    else if (d.kind === "nicotine") { x.nic += 1; x.nicMg += d.unit === "mg" ? d.amount : 6 * d.amount; }
    else if (d.kind === "stimulant") { x.stim += d.amount; x.stimMg += d.amount; }
  }
  for (const x of byDay.values()) {
    const runs = x.sessions.filter((s) => s.kind === "run");
    x.runKm = sum(runs.map((s) => s.distanceKm || 0));
    x.hasRun = runs.length > 0;
    x.hasLift = x.sessions.some((s) => s.kind === "lift");
    x.isRest = !x.hasRun && !x.hasLift && x.sessions.some((s) => s.kind === "rest");
    const paced = runs.map((s) => ({ p: paceSecOf(s, "km"), d: s.distanceKm || 0 })).filter((r) => r.p);
    x.paceSecKm = paced.length
      ? (paced.every((r) => r.d) ? sum(paced.map((r) => r.p * r.d)) / sum(paced.map((r) => r.d)) : avg(paced.map((r) => r.p)))
      : null;
  }
  const get = (k) => byDay.get(k) || { ...blank(k), runKm: 0, hasRun: false, hasLift: false, isRest: false, paceSecKm: null };
  return { byDay, get };
}
