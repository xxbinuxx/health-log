// Step two: Strava sends the person back here with a code. Swap it for tokens and store them.
import { admin, env, json } from "./lib/shared.js";

const page = (site, msg, ok) => ({
  statusCode: 302,
  headers: { Location: `${site}/?strava=${ok ? "connected" : "failed"}&msg=${encodeURIComponent(msg)}` },
  body: "",
});

export async function handler(event) {
  const site = env("URL") || `https://${event.headers.host}`;
  try {
    const { code, state, error: denied } = event.queryStringParameters || {};
    if (denied) return page(site, "You cancelled the Strava connection.", false);
    if (!code || !state) return page(site, "Strava did not send a code back.", false);

    const db = admin();
    const { data: st } = await db.from("strava_oauth_state").select("user_id").eq("nonce", state).maybeSingle();
    if (!st) return page(site, "That connection link expired. Try Connect Strava again.", false);

    const r = await fetch("https://www.strava.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env("STRAVA_CLIENT_ID"),
        client_secret: env("STRAVA_CLIENT_SECRET"),
        code, grant_type: "authorization_code",
      }),
    });
    const j = await r.json();
    if (!j.access_token) return page(site, "Strava refused the connection. Check the Client ID and Secret in Netlify.", false);

    await db.from("strava_tokens").upsert({
      user_id: st.user_id,
      athlete_id: j.athlete?.id ?? null,
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: j.expires_at,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id" });
    await db.from("strava_oauth_state").delete().eq("nonce", state);

    return page(site, "Strava connected.", true);
  } catch (e) {
    return page(site, String(e.message || e), false);
  }
}
