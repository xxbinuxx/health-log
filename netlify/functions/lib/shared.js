// Bits shared by the Strava functions.
import { createClient } from "@supabase/supabase-js";

export const env = (n) => process.env[n] || "";

// Admin client: bypasses row-level security. Only ever used inside these server functions.
export function admin() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export const json = (status, body) => ({
  statusCode: status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

// Who is calling? Reads the Supabase session token the app sends.
export async function userFromRequest(event, db) {
  const auth = event.headers.authorization || event.headers.Authorization || "";
  const jwt = auth.replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await db.auth.getUser(jwt);
  if (error) return null;
  return data?.user ?? null;
}

// Strava access tokens last six hours; swap an expired one for a new one.
export async function freshToken(db, row) {
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at && row.expires_at > now + 120) return row.access_token;
  const r = await fetch("https://www.strava.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env("STRAVA_CLIENT_ID"),
      client_secret: env("STRAVA_CLIENT_SECRET"),
      grant_type: "refresh_token",
      refresh_token: row.refresh_token,
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`Strava refused to refresh the token: ${JSON.stringify(j)}`);
  await db.from("strava_tokens").update({
    access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at,
    updated_at: new Date().toISOString(),
  }).eq("user_id", row.user_id);
  return j.access_token;
}

const KM_PER_MI = 1.609344;
const round = (n, d = 1) => (n == null || isNaN(n) ? null : Math.round(n * 10 ** d) / 10 ** d);

function inferRunType(name, distKm, sportType) {
  const s = String(name || "").toLowerCase();
  if (/\brace\b|5k|10k|half|marathon/.test(s)) return "race";
  if (/interval|repeat|\btrack\b|speed|fartlek|\d+\s*x\s*\d+/.test(s)) return "intervals";
  if (/tempo|threshold|progression/.test(s)) return "tempo";
  if (/long run|\blong\b(?! island)/.test(s)) return "long";
  if (/trail/.test(s) || /trail/i.test(sportType || "")) return "trail";
  if (distKm && distKm >= 16) return "long";
  return "easy";
}

export const isRun = (t) => /run|jog|trail|treadmill/i.test(t || "");
/* Strava's own gym activity types, so lifts stop needing to be logged by hand. */
export const isLift = (t) => /weight ?training|workout|crossfit/i.test(t || "");
/* Hiking is real aerobic load — time on feet, and descending is specific preparation
   for a downhill race — so it counts toward volume. Its pace is not comparable to
   running pace, so it is imported without one and stays out of the pace medians. */
export const isHike = (t) => /hike|walk|snowshoe/i.test(t || "");

export function toHike(a) {
  const local = String(a.start_date_local || a.start_date || "");
  const distKm = (a.distance || 0) / 1000;
  return {
    id: `strava-${a.id}`,
    date: local.slice(0, 10),
    ts: new Date(a.start_date || local).getTime(),
    kind: "run", type: "hike",
    name: String(a.name || "Hike").slice(0, 80),
    distanceKm: Math.round(distKm * 1000) / 1000,
    movingSec: a.moving_time || a.elapsed_time || null,
    paceSecPerKm: null,
    elevationGain: a.total_elevation_gain ?? null,
    note: "", source: "strava",
  };
}

function inferLiftType(name) {
  const s = String(name || "").toLowerCase();
  if (/pull/.test(s) && /leg|squat/.test(s)) return "lower";
  if (/push|chest|bench|shoulder|press|tricep/.test(s)) return "push";
  if (/pull|back|row|lat|bicep|chin/.test(s)) return "pull";
  if (/leg|squat|deadlift|rdl|lunge|calf/.test(s)) return "legs";
  if (/upper/.test(s)) return "upper";
  return "full body";
}

/* A gym session from Strava, in the shape the app stores lifts in. */
export function toLift(a) {
  const local = String(a.start_date_local || a.start_date || "");
  const name = String(a.name || "Lift").slice(0, 80);
  return {
    id: `strava-${a.id}`,
    date: local.slice(0, 10),
    ts: new Date(a.start_date || local).getTime(),
    kind: "lift",
    type: inferLiftType(name),
    name,
    movingSec: a.moving_time || a.elapsed_time || null,
    note: "", source: "strava",
  };
}

// One Strava activity in the shape the app stores sessions in.
export function toSession(a) {
  const distKm = (a.distance || 0) / 1000;
  const movingSec = a.moving_time || a.elapsed_time || null;
  const local = String(a.start_date_local || a.start_date || "");
  const date = local.slice(0, 10);
  const ts = new Date(a.start_date || local).getTime();
  const name = String(a.name || "Run").slice(0, 80);
  return {
    id: `strava-${a.id}`,
    date, ts, kind: "run",
    type: inferRunType(name, distKm, a.sport_type || a.type),
    name,
    distanceKm: round(distKm, 3),
    movingSec,
    paceSecPerKm: movingSec && distKm ? round(movingSec / distKm, 1) : null,
    note: "", source: "strava",
  };
}

// Write sessions into the same key the app reads, keeping anything already there.
// A Strava run replaces a hand-typed run on the same day but inherits its type and note.
export async function mergeSessions(db, userId, incoming) {
  const key = "hl2:sessions";
  const { data } = await db.from("hl_store").select("value").eq("user_id", userId).eq("key", key).maybeSingle();
  const existing = Array.isArray(data?.value) ? data.value : [];
  const days = new Set(incoming.map((s) => s.date));
  const replaced = existing.filter((s) => s.kind === "run" && s.source === "manual" && days.has(s.date));
  const kept = existing.filter((s) => !replaced.includes(s));
  const enriched = incoming.map((s) => {
    const m = replaced.find((x) => x.date === s.date);
    return m ? { ...s, type: m.type || s.type, note: m.note || s.note } : s;
  });
  const byId = new Map(kept.map((s) => [s.id, s]));
  let added = 0;
  for (const s of enriched) { if (!byId.has(s.id)) added++; byId.set(s.id, { ...byId.get(s.id), ...s }); }
  const { error } = await db.from("hl_store").upsert(
    { user_id: userId, key, value: [...byId.values()], updated_at: new Date().toISOString() },
    { onConflict: "user_id,key" }
  );
  if (error) throw new Error(error.message);
  return { added, replaced: replaced.length, total: byId.size };
}
