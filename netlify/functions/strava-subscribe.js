// Turn automatic sync on or off: manages the one webhook subscription Strava allows per app.
import { admin, env, json, userFromRequest } from "./lib/shared.js";

const creds = () => `client_id=${env("STRAVA_CLIENT_ID")}&client_secret=${encodeURIComponent(env("STRAVA_CLIENT_SECRET"))}`;

export async function handler(event) {
  try {
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!env("STRAVA_VERIFY_TOKEN")) return json(500, { error: "STRAVA_VERIFY_TOKEN is not set in Netlify." });

    const site = env("URL") || `https://${event.headers.host}`;
    const callback = `${site}/.netlify/functions/strava-webhook`;
    const listUrl = `https://www.strava.com/api/v3/push_subscriptions?${creds()}`;

    const existing = await (await fetch(listUrl)).json();
    const action = (event.queryStringParameters || {}).action || "status";

    if (action === "status") {
      const sub = Array.isArray(existing) ? existing[0] : null;
      return json(200, { active: !!sub && sub.callback_url === callback, subscription: sub ?? null, callback });
    }

    if (action === "off") {
      if (Array.isArray(existing)) {
        for (const s of existing) {
          await fetch(`https://www.strava.com/api/v3/push_subscriptions/${s.id}?${creds()}`, { method: "DELETE" });
        }
      }
      return json(200, { active: false, message: "Automatic sync turned off." });
    }

    // action === "on"
    if (Array.isArray(existing) && existing.length) {
      if (existing[0].callback_url === callback) return json(200, { active: true, message: "Automatic sync was already on." });
      for (const s of existing) {
        await fetch(`https://www.strava.com/api/v3/push_subscriptions/${s.id}?${creds()}`, { method: "DELETE" });
      }
    }

    const body = new URLSearchParams({
      client_id: env("STRAVA_CLIENT_ID"),
      client_secret: env("STRAVA_CLIENT_SECRET"),
      callback_url: callback,
      verify_token: env("STRAVA_VERIFY_TOKEN"),
    });
    const r = await fetch("https://www.strava.com/api/v3/push_subscriptions", { method: "POST", body });
    const j = await r.json();
    if (!j.id) return json(502, { error: `Strava would not set up the webhook: ${JSON.stringify(j)}` });
    return json(200, { active: true, message: "Automatic sync is on. New runs will appear a minute after they upload." });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
}
