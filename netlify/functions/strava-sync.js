// Catch-up sync: pull runs on demand, in pages, so a full history works as well as a recent top-up.
import { admin, freshToken, isRun, toSession, mergeSessions, json, userFromRequest } from "./lib/shared.js";

export async function handler(event) {
  try {
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });

    const q = event.queryStringParameters || {};
    const days = Math.min(7300, Number(q.days) || 30);          // up to twenty years
    const maxPages = Math.min(40, Number(q.pages) || 20);        // 20 pages = 4000 activities

    const { data: row } = await db.from("strava_tokens").select("*").eq("user_id", user.id).maybeSingle();
    if (!row) return json(400, { error: "Strava is not connected yet." });

    const token = await freshToken(db, row);
    const after = Math.floor(Date.now() / 1000) - days * 86400;

    const runs = [];
    let seen = 0, page = 1, hitCap = false;
    for (; page <= maxPages; page++) {
      const r = await fetch(`https://www.strava.com/api/v3/athlete/activities?after=${after}&per_page=200&page=${page}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.status === 429) { hitCap = true; break; }            // Strava rate limit
      const list = await r.json();
      if (!Array.isArray(list)) return json(502, { error: `Strava said: ${JSON.stringify(list)}` });
      if (!list.length) break;
      seen += list.length;
      for (const a of list) if (isRun(a.sport_type || a.type)) runs.push(toSession(a));
      if (list.length < 200) break;
    }

    if (!runs.length) {
      return json(200, { added: 0, total: 0, message: `Looked at ${seen} activities and found no runs.` });
    }

    const res = await mergeSessions(db, user.id, runs);
    const note = hitCap ? " Strava paused us on rate limits, so run this again in fifteen minutes to finish." : "";
    return json(200, {
      ...res,
      message: `${runs.length} run${runs.length === 1 ? "" : "s"} read from ${seen} activities, ${res.added} new.${note}`,
    });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
}
