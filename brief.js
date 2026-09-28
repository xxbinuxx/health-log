// Turns a log into the words that go in the 6am email. Pure, so it can be tested on its own.
import {
  addDays, lastNDays, mondayOf, toUnit, round, avg, sum, median, relToMedian,
  secsToClock, minsToHM, buildIndices, rollup,
} from "../../../scores.js";

const pct = (v) => (v == null ? null : Math.round(v));

export function buildBrief({ doses, sleep, sessions, days, settings }, todayKey) {
  const s = { distanceUnit: "mi", weeklyDistanceTarget: 40, sleepHoursGoal: 7.5, dayStartHour: 4, ...settings };
  const u = s.distanceUnit;
  const daily = rollup({ doses, sleep, sessions, days, settings: s });
  const span = lastNDays(90, todayKey);
  const rows = buildIndices(daily, span, s);
  const now = rows[rows.length - 1] || {};
  const rel = {};
  for (const k of ["regen", "run", "degen"]) {
    const vals = rows.map((r) => r[k]).filter((v) => v != null);
    rel[k] = vals.length >= 3 ? pct(relToMedian(now[k], vals)) : null;
  }

  const y = addDays(todayKey, -1);
  const yd = daily.get(y);
  // a rolling seven days is the honest read; on a Monday the calendar week is always near zero
  const roll7 = lastNDays(7, addDays(todayKey, -1));
  const rollMi = round(toUnit(sum(roll7.map((k) => daily.get(k).runKm)), u), 1) ?? 0;
  const mtd = lastNDays(7, todayKey).filter((k) => k >= mondayOf(todayKey) && k < todayKey);
  const wkMi = round(toUnit(sum(mtd.map((k) => daily.get(k).runKm)), u), 1) ?? 0;
  const target = s.weeklyDistanceTarget || 40;
  const daysLeftInWeek = 7 - mtd.length;

  // days in a row ending yesterday with a session and no day off
  let streak = 0;
  for (let i = 1; i <= 30; i++) {
    const x = daily.get(addDays(todayKey, -i));
    if (x.hasRun || x.hasLift) streak++; else break;
  }
  const lastHard = (() => {
    for (let i = 1; i <= 21; i++) {
      const x = daily.get(addDays(todayKey, -i));
      if (x.hasRun && (x.runKm >= 16 || ["long", "tempo", "intervals", "race"].includes(x.sessions.find((v) => v.kind === "run")?.type))) return i;
    }
    return null;
  })();

  const loggedYesterday = !!(yd.sleep || yd.sessions.length || yd.entries.length || yd.tags.length || yd.note);
  const raceDays = s.race?.date ? Math.ceil((new Date(s.race.date) - new Date(todayKey)) / 864e5) : null;

  /* ---- the read ---- */
  const lines = [];
  // headline each score the way the app does: where it sits against your own 90 days, raw alongside
  const band = (k, good) => {
    const r = rel[k], raw = pct(now[k]);
    if (raw == null) return "no data";
    const word = r == null ? "" : r >= 80 ? (good ? ", well above your usual" : ", one of your heavier stretches")
      : r >= 60 ? (good ? ", above your usual" : ", above your usual")
      : r >= 40 ? ", about your usual"
      : r >= 20 ? (good ? ", below your usual" : ", quieter than usual")
      : (good ? ", near your lowest" : ", about as quiet as it gets");
    return `${r ?? raw}${r != null ? ` of 100` : ""}${word} (raw ${raw})`;
  };
  lines.push(`Regen ${band("regen", true)}.` + (yd.sleep?.score != null
    ? ` Last night ${yd.sleep.score}${yd.sleep.asleepMin ? ` on ${minsToHM(yd.sleep.asleepMin)}` : ""}.`
    : " No sleep score logged for last night."));
  const fresh = now.freshness;
  const freshTxt = fresh == null ? "" :
    fresh >= 15 ? " Well rested." : fresh >= 5 ? " Rested." : fresh > -12 ? "" : " Carrying real fatigue.";
  lines.push(`Stamina ${band("run", true)}.${freshTxt} ${rollMi} ${u} in the last seven days against a ${target} target` +
    (mtd.length > 0 ? `; ${wkMi} so far this week with ${daysLeftInWeek} day${daysLeftInWeek === 1 ? "" : "s"} to go.` : ", and the week has just turned over."));
  // Degen leads with the absolute amount: "above your median" reads oddly on a day you had nothing.
  const dRaw = pct(now.degen) ?? 0;
  const dWord = dRaw >= 60 ? "heavy" : dRaw >= 35 ? "elevated" : dRaw >= 15 ? "moderate" : "light";
  lines.push(`Degen ${dRaw}, ${dWord}${rel.degen != null ? ` — ${rel.degen} of 100 against your last 90 days` : ""}.` +
    (yd.alc || yd.thcMg || yd.thcSessions ? ` Yesterday: ${yd.alc ? `${round(yd.alc, 1)} drinks` : ""}${yd.alc && (yd.thcMg || yd.thcSessions) ? ", " : ""}${yd.thcMg ? `${round(yd.thcMg, 1)} mg THC` : yd.thcSessions ? `${yd.thcSessions} session${yd.thcSessions === 1 ? "" : "s"}` : ""}.` : " Nothing logged yesterday."));

  /* ---- the suggestion: plain rules on your own numbers ---- */
  // Thresholds read yesterday's actual amounts, not the relative scale, because half of all
  // days sit above the median by definition and that is not news.
  const heavy = yd.alc > 4.5 || yd.thcMg > 5;
  const someDrink = yd.alc > 0 || yd.thcMg > 0 || yd.thcSessions > 0;
  const lowRegen = rel.regen != null ? rel.regen < 30 : (yd.sleep?.score ?? 100) < 65;
  const elevatedDegen = rel.degen != null && rel.degen >= 85;
  const behind = daysLeftInWeek > 0 && wkMi < target * ((7 - daysLeftInWeek) / 7) * 0.75;

  let plan, why;
  if (heavy && lowRegen) {
    plan = "Easy or nothing today.";
    why = "Heavy night with a poor sleep score behind it — hard efforts off that base tend to go badly.";
  } else if (raceDays != null && raceDays >= 0 && raceDays <= 10) {
    plan = raceDays <= 2 ? "Shake-out only, 20 to 30 minutes." : raceDays <= 5 ? "Short and sharp, well short of exhaustion." : "Hold the volume down, keep one quality session in.";
    why = `${raceDays} day${raceDays === 1 ? "" : "s"} to ${s.race?.name || "race day"}.`;
  } else if (lastHard != null && lastHard <= 1) {
    plan = "Easy recovery run.";
    why = "Yesterday was long or hard.";
  } else if (heavy) {
    plan = "Keep it easy and conversational.";
    why = "Last night was a heavy one; pace tends to suffer more than how you feel at the start.";
  } else if (lowRegen) {
    plan = "Easy miles, or swap it for a lift.";
    why = "Sleep is near the bottom of your range — the aerobic work still banks, the intensity won't.";
  } else if (fresh != null && fresh <= -18) {
    plan = "Easy, and think about a day off soon.";
    why = `Fatigue is running well ahead of fitness (${Math.round(fresh)}%).`;
  } else if (streak >= 10) {
    plan = "Take the day off.";
    why = `${streak} days straight with a session and no rest logged.`;
  } else if (elevatedDegen && someDrink) {
    plan = "Steady, not hard.";
    why = "Intake has been running near the top of your range this week.";
  } else if (behind) {
    const need = round((target - wkMi) / Math.max(1, daysLeftInWeek), 1);
    plan = `A steady run of about ${need} ${u} keeps the week on track.`;
    why = `${wkMi} of ${target} ${u} with ${daysLeftInWeek} day${daysLeftInWeek === 1 ? "" : "s"} to go.`;
  } else if (lastHard == null || lastHard >= 3) {
    plan = "Good day for quality: tempo or intervals.";
    why = lastHard == null ? "No hard session logged in the last three weeks." : `${lastHard} days since your last hard effort, and sleep is where it should be.`;
  } else {
    plan = "Easy or steady, your call.";
    why = "Nothing in the numbers argues either way.";
  }

  const nudges = [];
  if (!loggedYesterday) nudges.push("Nothing is logged for yesterday yet.");
  if (yd.sleep && yd.sleep.score == null) nudges.push("Last night's sleep score is missing.");

  return {
    subject: `${plan.replace(/\.$/, "")} · Regen ${rel.regen ?? pct(now.regen) ?? "—"}, Degen ${rel.degen ?? pct(now.degen) ?? "—"}`,
    lines, plan, why, nudges,
    scores: { regen: pct(now.regen), run: pct(now.run), degen: pct(now.degen), rel },
  };
}

export function briefText(b, siteUrl) {
  return [
    ...b.lines,
    "",
    `Today: ${b.plan}`,
    b.why,
    ...(b.nudges.length ? ["", ...b.nudges] : []),
    "",
    siteUrl || "",
  ].filter((x) => x !== undefined).join("\n");
}

export function briefHtml(b, siteUrl) {
  const esc = (t) => String(t).replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#0D1B30;max-width:520px">
  <div style="font-size:19px;font-weight:600;color:#12345E;margin-bottom:12px">${esc(b.plan)}</div>
  <div style="color:#3D5171">${b.lines.map(esc).join("<br>")}</div>
  <div style="margin:14px 0;padding:12px 14px;background:#EEF2F7;border-left:3px solid #0072B2">${esc(b.why)}</div>
  ${b.nudges.length ? `<div style="color:#D55E00">${b.nudges.map(esc).join("<br>")}</div>` : ""}
  <div style="margin-top:18px"><a href="${siteUrl}" style="color:#0072B2">Open the log</a></div>
</div>`;
}
