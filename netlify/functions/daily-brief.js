// Runs on a schedule, once each morning. Reads the log, writes the note, sends the email.
import { admin, env, json } from "./lib/shared.js";
import { buildBrief, briefText, briefHtml, briefFacts, briefTextWritten, briefHtmlWritten, WRITER_SYSTEM } from "./lib/brief.js";
import { chat, groqReady, tryGroq } from "./lib/groq.js";

const KEYS = { doses: "hl2:doses", sleep: "hl2:sleep", sessions: "hl2:sessions", lifts: "hl2:lifts", days: "hl2:days", settings: "hl2:settings" };

// the local date in New York, whatever the server thinks the time is
function localParts(tz = "America/New_York") {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

async function loadAll(db, userId) {
  const { data } = await db.from("hl_store").select("key,value").eq("user_id", userId);
  const map = Object.fromEntries((data || []).map((r) => [r.key, r.value]));
  return {
    doses: map[KEYS.doses] || [], sleep: map[KEYS.sleep] || [],
    sessions: map[KEYS.sessions] || [], days: map[KEYS.days] || [],
    settings: map[KEYS.settings] || {},
  };
}

async function sendEmail(to, subject, text, html) {
  const key = env("RESEND_API_KEY");
  if (!key) throw new Error("RESEND_API_KEY is not set in Netlify.");
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env("BRIEF_FROM") || "Health log <onboarding@resend.dev>", to: [to], subject, text, html }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Resend refused it: ${JSON.stringify(j)}`);
  return j.id;
}

export async function runBrief(event = {}) {
  const q = event?.queryStringParameters || {};
  const force = q.force === "1";            // skip the clock check
  const dry = q.dry === "1";                // compose but do not send
  const tz = env("BRIEF_TZ") || "America/New_York";
  const sendHour = Number(env("BRIEF_HOUR") || 6);
  const { date, hour } = localParts(tz);

  console.log(`daily-brief: ${date} ${tz} local hour ${hour}, target ${sendHour}, force=${force} dry=${dry}`);
  if (!env("RESEND_API_KEY")) console.error("daily-brief: RESEND_API_KEY is not set — nothing can be sent");
  if (!force && hour !== sendHour) {
    console.log(`daily-brief: not the hour yet, stopping`);
    return json(200, { skipped: `local hour is ${hour}, waiting for ${sendHour}` });
  }

  try {
    const db = admin();
    const { data: users, error } = await db.auth.admin.listUsers();
    if (error) { console.error("daily-brief: cannot list users —", error.message); return json(500, { error: error.message }); }
    console.log(`daily-brief: ${users?.users?.length ?? 0} user(s) found`);

    const out = [];
    for (const u of users.users || []) {
      const state = await loadAll(db, u.id);
      if (state.settings?.dailyBrief === false) { out.push({ user: u.email, skipped: "turned off" }); continue; }
      if (!state.sleep.length && !state.sessions.length && !state.doses.length) { out.push({ user: u.email, skipped: "nothing logged yet" }); continue; }

      const markKey = "hl2:briefSent";
      if (!force) {
        const { data: mark } = await db.from("hl_store").select("value").eq("user_id", u.id).eq("key", markKey).maybeSingle();
        if (mark?.value === date) { out.push({ user: u.email, skipped: "already sent today" }); continue; }
      }

      const brief = buildBrief(state, date);
      const site = env("URL") || "";

      // Let the model phrase it, but only from figures we computed. If it is unavailable
      // or slow, the fixed sentences go out instead and the email still arrives.
      const prose = await tryGroq(
        () => chat(WRITER_SYSTEM, JSON.stringify(briefFacts(brief), null, 1), { temperature: 0.7, maxTokens: 220 }),
        null, "daily-brief/writer"
      );
      const text = prose ? briefTextWritten(prose, brief, site) : briefText(brief, site);
      const html = prose ? briefHtmlWritten(prose, brief, site) : briefHtml(brief, site);
      console.log(`daily-brief: prose ${prose ? "written by model" : "fell back to fixed text"}`);

      if (dry) { out.push({ user: u.email, dry: text }); continue; }

      console.log(`daily-brief: sending to ${u.email}`);
      const id = await sendEmail(u.email, brief.subject, text, html);
      console.log(`daily-brief: sent, resend id ${id}`);
      await db.from("hl_store").upsert({ user_id: u.id, key: markKey, value: date, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
      out.push({ user: u.email, sent: id });
    }
    console.log("daily-brief: done —", JSON.stringify(out));
    return json(200, { date, results: out });
  } catch (e) {
    console.error("daily-brief: failed —", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}

export const handler = runBrief;
