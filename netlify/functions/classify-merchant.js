// The merchant names the pattern rules could not place. The model sorts them once,
// the answer is cached, and nothing is reclassified twice.
import { admin, json, userFromRequest } from "./lib/shared.js";
import { chatJson, groqReady } from "./lib/groq.js";

const KEY = "hl2:merchantMap";

const SYSTEM = `You sort merchant names from a US credit card statement into three buckets.

"out"   — bars, restaurants, cafes, clubs, food delivery, event tickets, venues, late-night rides: money spent while out of the house
"home"  — streaming, gaming, app and software subscriptions, sports betting, anything consumed at home
"other" — groceries, rent, utilities, transport, travel, retail, medical, everything else

Return JSON: {"results": [{"name": "exactly as given", "bucket": "out|home|other", "confidence": 0-1}]}

Rules:
1. Card statements mangle names. "TST*", "SQ*", "TOAST*" and "AplPay" are payment prefixes, not part of the merchant. Judge the name after the prefix.
2. A place name with no clue about what it sells is "other" with low confidence. Do not guess optimistically.
3. A person's name is "other" with confidence 0.2 — it is probably a transfer.
4. One entry per input name, in the same order, with the name copied exactly.`;

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!groqReady()) return json(503, { error: "no AI key is set in Netlify (AI_API_KEY or GROQ_API_KEY)." });

    const { names = [] } = JSON.parse(event.body || "{}");
    if (!names.length) return json(400, { error: "No merchant names sent." });

    const { data } = await db.from("hl_store").select("value").eq("user_id", user.id).eq("key", KEY).maybeSingle();
    const cached = data?.value && typeof data.value === "object" ? data.value : {};

    const todo = [...new Set(names.map((n) => String(n).trim()).filter((n) => n && !cached[n]))].slice(0, 120);
    let added = 0;
    for (let i = 0; i < todo.length; i += 30) {           // small batches keep the reply inside the token limit
      const batch = todo.slice(i, i + 30);
      const out = await chatJson(SYSTEM, JSON.stringify({ names: batch }), { temperature: 0, maxTokens: 1200 });
      for (const r of out?.results || []) {
        if (!r?.name || !["out", "home", "other"].includes(r.bucket)) continue;
        cached[r.name] = { bucket: r.bucket, confidence: Number(r.confidence) || 0.5 };
        added++;
      }
    }
    if (added) {
      await db.from("hl_store").upsert({ user_id: user.id, key: KEY, value: cached, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
    }
    return json(200, { map: cached, classified: added, asked: todo.length });
  } catch (e) {
    console.error("classify-merchants:", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}
