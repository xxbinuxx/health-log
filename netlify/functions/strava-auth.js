// Step one of connecting: hand back the Strava approval URL for the signed-in person.
import { admin, env, json, userFromRequest } from "./lib/shared.js";

export async function handler(event) {
  try {
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!env("STRAVA_CLIENT_ID")) return json(500, { error: "STRAVA_CLIENT_ID is not set in Netlify." });

    // A one-time ticket so the trip out to Strava and back can be tied to this account.
    const nonce = crypto.randomUUID();
    const { error } = await db.from("strava_oauth_state").insert({ nonce, user_id: user.id });
    if (error) return json(500, { error: error.message });

    const site = env("URL") || `https://${event.headers.host}`;
    const params = new URLSearchParams({
      client_id: env("STRAVA_CLIENT_ID"),
      redirect_uri: `${site}/.netlify/functions/strava-callback`,
      response_type: "code",
      approval_prompt: "auto",
      scope: "read,activity:read_all",
      state: nonce,
    });
    return json(200, { url: `https://www.strava.com/oauth/authorize?${params}` });
  } catch (e) {
    return json(500, { error: String(e.message || e) });
  }
}
