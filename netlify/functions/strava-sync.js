// Manual catch-up: pull recent runs on demand, in case a webhook was missed.
import { admin, freshToken, isRun, toSession, mergeSessions, json, userFromRequest } from "./lib/shared.js";

export async function handler(event) {
  try {
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });

    const days = Math.min(365, Number((event.queryStringParameters || {}).days) || 30);
    const { data: row } = await db.from("strava_tokens").select("*").eq("user_id", user.id).maybeSingle();
    if (!row) return json(400, { error: "Strava is not connected yet." });

    const token = await freshToken(db, row);
    const after = Math.floor(Date.now() / 1000) - days * 86400;
    const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const list = await r.json();
    if (!Array.isArray(list)) return json(502, { error: `Strava said: ${JSON.stringify(list)}` });

    const runs = list.filter((a) => isRun(a.sport_type || a.type)).map(toSession);
    if (!runs.length) return json(200, { added: 0, total: 0, message: `No runs in the last ${days} days.` });

    const res = await mergeSessions(db, user.id, runs);
    return json(200, { ...res, message: `${runs.length} run${runs.length === 1 ? "" : "s"} read, ${res.added} new.` });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
}
