// Strava calls this: once to verify the address, then every time an activity changes.
import { admin, env, freshToken, isRun, toSession, mergeSessions } from "./lib/shared.js";

export async function handler(event) {
  // Verification handshake when the subscription is created.
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    if (q["hub.verify_token"] !== env("STRAVA_VERIFY_TOKEN")) return { statusCode: 403, body: "bad verify token" };
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ "hub.challenge": q["hub.challenge"] }),
    };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "" };

  // Strava wants a fast acknowledgement, so never fail loudly here.
  try {
    const e = JSON.parse(event.body || "{}");
    if (e.object_type !== "activity") return { statusCode: 200, body: "ignored" };

    const db = admin();
    const { data: row } = await db.from("strava_tokens").select("*").eq("athlete_id", e.owner_id).maybeSingle();
    if (!row) return { statusCode: 200, body: "unknown athlete" };

    if (e.aspect_type === "delete") {
      const key = "hl2:sessions";
      const { data } = await db.from("hl_store").select("value").eq("user_id", row.user_id).eq("key", key).maybeSingle();
      const list = Array.isArray(data?.value) ? data.value : [];
      await db.from("hl_store").upsert(
        { user_id: row.user_id, key, value: list.filter((s) => s.id !== `strava-${e.object_id}`), updated_at: new Date().toISOString() },
        { onConflict: "user_id,key" }
      );
      return { statusCode: 200, body: "deleted" };
    }

    const token = await freshToken(db, row);
    const r = await fetch(`https://www.strava.com/api/v3/activities/${e.object_id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const a = await r.json();
    if (!a || !a.id) return { statusCode: 200, body: "activity not readable" };
    if (!isRun(a.sport_type || a.type)) return { statusCode: 200, body: "not a run" };

    await mergeSessions(db, row.user_id, [toSession(a)]);
    return { statusCode: 200, body: "ok" };
  } catch (err) {
    console.error("strava-webhook", err);
    return { statusCode: 200, body: "error logged" };
  }
}
