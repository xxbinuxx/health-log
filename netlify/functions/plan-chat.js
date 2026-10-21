// A chat that edits the stored training calendar. The model proposes day-level edits
// from a fixed vocabulary; the browser applies them to the stored records and refuses
// anything that breaks the shape of a taper. The model never writes the plan directly.
import { admin, json, userFromRequest } from "./lib/shared.js";
import { chatJson, groqReady } from "./lib/groq.js";
import { rollup, toDayKey, addDays, secsToClock, round, sum } from "../../scores.js";
import { buildPlan, raceType } from "../../plan.js";

const KEYS = { doses: "hl2:doses", sleep: "hl2:sleep", sessions: "hl2:sessions", days: "hl2:days", settings: "hl2:settings" };

async function load(db, userId) {
  const { data } = await db.from("hl_store").select("key,value").eq("user_id", userId);
  const m = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return { doses: m[KEYS.doses] || [], sleep: m[KEYS.sleep] || [], sessions: m[KEYS.sessions] || [],
    days: m[KEYS.days] || [], settings: m[KEYS.settings] || {} };
}

const SYSTEM = `You are a marathon coach editing someone's training calendar. The calendar is a list of days, each with a session. You return edits to specific days.

Return JSON only:
{
  "reply": "what you are telling them, 1-3 sentences, plain and direct",
  "operations": [ ... ]
}

Operations available:
- {"op":"setDay","date":"YYYY-MM-DD","kind":"run|lift|rest","title":"Long run","miles":20,"note":"optional"}
- {"op":"moveDay","from":"YYYY-MM-DD","to":"YYYY-MM-DD"} — swaps the two days
- {"op":"scaleWeek","monday":"YYYY-MM-DD","factor":0.8} — scales every run that week

Reading shorthand:
A message like "Set exactly, 2026: 10/26 rest; 10/27 intervals 4; 10/31 long run 15" is a list of days in M/D format for the year given. Convert each to a setDay operation: the number is miles, the words are the title, "rest" means kind rest, anything with "lift" means kind lift, everything else is kind run. Emit one operation per day listed, in order, and do not add days that were not listed.

Rules:
- Only edit dates in the calendar you are shown. Never invent dates.
- When the person writes "set exactly", apply their numbers as given. They have thought about it; do not substitute your own.
- Race day cannot be changed or moved.
- The last three weeks before the race are a taper: each week's total should be lower than the week before. Taper weeks still contain long runs — just shorter ones, typically stepping down from the peak. Setting a 14 and then a 10 inside the taper is correct and you should allow it. What you must not do is let taper mileage climb.
- No long run more than 4 miles beyond the longest already planned or run before it.
- A long run should not exceed about 60% of its week.
- Return an empty operations list when they are only asking a question.
- Quote the figures you are given. Never invent mileage or paces.
- Say plainly when a request would be a bad idea, and offer the nearest sensible alternative as operations.`;

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!groqReady()) return json(503, { error: "Plan chat is not set up: no AI key in Netlify." });

    const body = JSON.parse(event.body || "{}");
    const { message, history = [] } = body;
    const sentPlan = Array.isArray(body.plan) ? body.plan : [];
    if (!message || message.length < 2) return json(400, { error: "Say something." });
    if (message.length > 4000) return json(400, { error: "That is too long even for a full schedule — split it across two messages." });
    const state = await load(db, user.id);
    const today = toDayKey(new Date());
    const upcoming = (state.settings?.races || []).filter((x) => x.date >= today).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
    const r = upcoming || state.settings?.race;
    if (!r?.date || !r?.goalTime) return json(400, { error: "Add an upcoming race with a goal time first." });

    const parts = String(r.goalTime).split(":").map(Number);
    const goalSeconds = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
    const daily = rollup({ ...state, settings: state.settings });
    const plan = buildPlan({ todayKey: today, raceDate: r.date, raceName: r.name, raceKind: r.kind,
      goalSeconds, daily, settings: state.settings });

    const convo = history.slice(-6).map((h) => `${h.role === "user" ? "Them" : "You"}: ${h.text}`).join("\n");
    // one line per day keeps the context small enough for the reply to finish
    const compact = sentPlan.map((d) => `${d.date} ${d.kind}${d.miles ? ` ${d.miles}mi` : ""} ${d.title}`).join("\n");
    const ctx = {
      today,
      race: { name: r.name, distance: raceType(r.kind).name, date: r.date, goal: r.goalTime,
        goal_pace: `${secsToClock(plan.paces.race)}/${plan.unit}` },
      taper_begins: plan.weeks[plan.taperStart]?.monday ?? null,
      form: { weekly_miles_recent: plan.form.recentWeekly, longest_90d: plan.form.longest, unit: plan.unit },
    };
    const out = await chatJson(SYSTEM,
      `Context:\n${JSON.stringify(ctx)}\n\nThe calendar from today onward:\n${compact}\n\n${convo ? `Earlier:\n${convo}\n\n` : ""}Them: ${message}`,
      { temperature: 0.2, maxTokens: 3000 });

    const ops = Array.isArray(out?.operations) ? out.operations.filter((o) => o && ["setDay", "moveDay", "scaleWeek"].includes(o.op)) : [];
    return json(200, { reply: out?.reply || "Done.", operations: ops });
  } catch (e) {
    console.error("plan-chat:", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}
