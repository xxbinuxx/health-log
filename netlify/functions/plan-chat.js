// A chat that can reshape the training plan — but only by proposing adjustments from a
// fixed vocabulary, which plan.js then checks against its own rules before applying.
// The model never writes the plan; it asks for changes, and the arithmetic decides.
import { admin, json, userFromRequest } from "./lib/shared.js";
import { chatJson, groqReady } from "./lib/groq.js";
import { rollup, toDayKey, addDays, secsToClock, round, sum } from "../../scores.js";
import { buildPlan, raceType, ADJUST_OPS } from "../../plan.js";

const KEYS = { doses: "hl2:doses", sleep: "hl2:sleep", sessions: "hl2:sessions", days: "hl2:days", settings: "hl2:settings" };

async function load(db, userId) {
  const { data } = await db.from("hl_store").select("key,value").eq("user_id", userId);
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return { doses: m[KEYS.doses] || [], sleep: m[KEYS.sleep] || [], sessions: m[KEYS.sessions] || [],
    days: m[KEYS.days] || [], settings: m[KEYS.settings] || {} };
}

const SYSTEM = `You are a marathon coach adjusting a training plan that someone else generates. You do not write the plan. You ask for specific changes, and the generator applies them only if they pass its safety rules.

The plan is shaped like Hal Higdon's Intermediate 2 and the BAA's level-four template: one long run a week, one interval session, a medium-long midweek run, a race-pace run, easy days between, a cutback every fourth week, peak long runs spaced two weeks apart with the last one three weeks out, then a taper.

Return JSON exactly:
{
  "reply": "what you are telling them, 1-4 sentences, plain and direct",
  "adjustments": [ { "op": "...", ...fields } ]
}

The only operations that exist:
- {"op":"setLong","week":N,"miles":X} — the long run in plan week N
- {"op":"setWeekVolume","week":N,"miles":X} — total mileage for week N
- {"op":"move","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} — swap two days' sessions
- {"op":"setIntervalMiles","miles":X}
- {"op":"setIntervalDay","dow":N} / {"op":"setRestDay","dow":N} / {"op":"setLongRunDay","dow":N} — 0 Sunday to 6 Saturday
- {"op":"setTwentyTarget","count":N} — how many peak long runs to fit

Rules you must respect, because the generator will refuse otherwise and you will look foolish:
- No long run more than 4 miles beyond anything already run or planned before it.
- No weekly volume more than about 10% above the week before.
- Nothing goes up during the taper — the final weeks come down, always.
- A long run may not exceed about 55% of its week's mileage. To grow one, raise the week first, in the same list.
- Race day is fixed and cannot be moved or changed.

How to behave:
- Only include adjustments the person actually asked for. An empty list is correct when they are just asking a question.
- When a request would break a rule, say so in the reply and offer the nearest thing that works, as adjustments.
- Quote the figures you are given exactly. Never invent mileage, paces or dates.
- Be honest when the plan is already right and a change would make it worse.`;

function context(plan) {
  const u = plan.unit;
  return {
    race: { name: plan.raceName, kind: plan.type.name, date: plan.raceDate, goal: secsToClock(plan.goalSeconds), goal_pace: `${secsToClock(plan.paces.race)}/${u}` },
    unit: u,
    today_form: {
      weekly_miles_recent: plan.form.recentWeekly, longest_90d: plan.form.longest,
      trend_pct: plan.form.trend, freshness_pct: plan.form.freshness,
      needs_peak_weekly: plan.form.need.peak,
    },
    taper_starts_at_week: plan.taperStart + 1,
    peak_long_distance: plan.type.peakLong,
    peak_long_runs_scheduled: plan.twenties,
    peak_long_runs_already_done_last_6_months: plan.past.flatMap((w) => w.days).filter((d) => (d.miles || 0) >= plan.type.peakLong * 0.95).length,
    // one line per week, not per day: the model only needs the shape, and a big
    // context is what makes the reply run out of room mid-JSON
    weeks: plan.weeks.map((w) => ({
      week: w.week, monday: w.monday, phase: w.phase,
      planned_miles: w.plannedMiles, long_run: w.longMiles,
      sessions: w.days.filter((d) => d.miles).map((d) => `${d.dow} ${d.title} ${d.miles}`).join(", "),
    })),
    current_adjustments: plan.applied,
    refused_adjustments: plan.rejected,
    operations: ADJUST_OPS,
  };
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!groqReady()) return json(503, { error: "Plan chat is not set up: no AI key in Netlify." });

    const { message, history = [] } = JSON.parse(event.body || "{}");
    if (!message || message.length < 2) return json(400, { error: "Say something." });
    if (message.length > 500) return json(400, { error: "That is too long — keep it to a sentence or two." });

    const state = await load(db, user.id);
    const r = state.settings?.race;
    if (!r?.date || !r?.goalTime) return json(400, { error: "Set a race date and goal time first." });

    const parts = String(r.goalTime).split(":").map(Number);
    const goalSeconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    const today = toDayKey(new Date());
    const daily = rollup({ ...state, settings: state.settings });
    const plan = buildPlan({ todayKey: today, raceDate: r.date, raceName: r.name, raceKind: r.kind,
      goalSeconds, daily, settings: state.settings });

    const convo = history.slice(-6).map((h) => `${h.role === "user" ? "Them" : "You"}: ${h.text}`).join("\n");
    const out = await chatJson(SYSTEM,
      `The plan right now:\n${JSON.stringify(context(plan))}\n\n${convo ? `Earlier:\n${convo}\n\n` : ""}Them: ${message}`,
      { temperature: 0.2, maxTokens: 1400 });

    const adjustments = Array.isArray(out?.adjustments) ? out.adjustments.filter((a) => a && ADJUST_OPS[a.op]) : [];
    return json(200, { reply: out?.reply || "Done.", adjustments });
  } catch (e) {
    console.error("plan-chat:", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}
