// Finds races through RunSignup's public API, on demand.
//
// Two rules from their developer terms shape this: calls are rate-limited to two at a
// time, and you may not copy their data into your own store. So this queries live,
// returns what it finds, and caches nothing beyond the life of the request.
//
// From 1 January 2027 every caller must register (free, a minute). Set RUNSIGNUP_TOKEN
// and RUNSIGNUP_SECRET in Netlify and they will be sent automatically.
import { admin, env, json, userFromRequest } from "./lib/shared.js";

const API = "https://runsignup.com/rest/races";

const DISTANCE_BANDS = {
  mile:     [0.9, 1.3],
  "5k":     [3.0, 3.3],
  "10k":    [6.0, 6.5],
  half:     [13.0, 13.3],
  marathon: [26.0, 26.6],
  "50k":    [30.5, 32],
  ultra:    [31, 200],
};

function matchesDistance(eventName, dist, want) {
  if (!want || want === "any") return true;
  const band = DISTANCE_BANDS[want];
  if (!band) return true;
  const mi = Number(dist);
  if (mi && mi >= band[0] && mi <= band[1]) return true;
  // fall back to the name when the distance field is empty
  const n = String(eventName || "").toLowerCase();
  const byName = { mile: /\bmile\b/, "5k": /\b5 ?k\b/, "10k": /\b10 ?k\b/,
    half: /\bhalf\b|13\.1/, marathon: /\bmarathon\b/, "50k": /\b50 ?k\b/, ultra: /\bultra|50 ?k|100 ?k|50 ?mile|100 ?mile\b/ };
  return byName[want]?.test(n) && !(want === "marathon" && /\bhalf\b/.test(n));
}

export async function handler(event) {
  try {
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });

    const q = event.queryStringParameters || {};
    const params = new URLSearchParams({
      format: "json",
      results_per_page: "100",
      start_date: q.from || "today",
      ...(q.to ? { end_date: q.to } : {}),
      ...(q.zip ? { zipcode: q.zip, radius: q.radius || "50" } : {}),
      ...(q.state ? { state: q.state } : {}),
      ...(q.name ? { name: q.name } : {}),
      ...(q.country ? { country_code: q.country } : {}),
      sort: "date ASC",
      events: "T",
    });
    if (env("RUNSIGNUP_TOKEN")) params.set("rsu_api_reg", env("RUNSIGNUP_TOKEN"));

    const r = await fetch(`${API}?${params}`, {
      headers: env("RUNSIGNUP_SECRET") ? { "X-RSU-API-REG-SECRET": env("RUNSIGNUP_SECRET") } : {},
    });
    if (!r.ok) return json(502, { error: `RunSignup returned ${r.status}` });
    const data = await r.json();

    const rows = [];
    for (const wrap of data?.races || []) {
      const race = wrap.race || wrap;
      const events = race.events || [];
      const matching = events.filter((e) => matchesDistance(e.name, e.distance, q.distance));
      if (q.distance && q.distance !== "any" && !matching.length) continue;
      const pick = matching[0] || events[0] || {};
      rows.push({
        id: `rsu-${race.race_id}`,
        name: race.name,
        date: (pick.start_time || race.next_date || "").slice(0, 10) || race.next_date,
        city: race.address?.city || "", state: race.address?.state || "",
        distance: pick.distance ? Number(pick.distance) : null,
        eventName: pick.name || "",
        url: race.url || `https://runsignup.com/Race/${race.race_id}`,
        logo: null,
      });
    }
    rows.sort((a, b) => (a.date < b.date ? -1 : 1));
    return json(200, { races: rows.slice(0, 60), source: "RunSignup" });
  } catch (e) {
    console.error("race-search:", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}
