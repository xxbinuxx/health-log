// Speak a sentence, get back structured entries to confirm. Whisper transcribes,
// then the model maps the words onto your own chips. Nothing is saved here —
// the browser shows a preview and you decide.
import { admin, json, userFromRequest } from "./lib/shared.js";
import { transcribe, chatJson, groqReady } from "./lib/groq.js";

const SYSTEM = `You turn a spoken sentence about someone's day into structured log entries.

Return JSON exactly in this shape:
{
  "intake": [{"preset_id": "string or null", "kind": "caffeine|alcohol|cannabis|nicotine|stimulant", "label": "string", "amount": number, "unit": "mg|drinks|hits|sessions"}],
  "workout": {"kind": "run|lift|rest", "type": "string", "distance": number or null, "pace": "m:ss or null", "note": "string"} or null,
  "sleep": {"score": number or null, "hours": number or null, "restingHr": number or null, "bodyBattery": number or null, "bedtime": "h:mmam/pm or null"} or null,
  "tags": ["string"],
  "note": "string",
  "unclear": ["anything you could not map confidently"]
}

Rules:
1. Match against the preset list you are given wherever possible and return its preset_id. Invent a preset_id for nothing.
2. Transcribe amounts exactly as spoken. If an amount is not stated, use the preset's default and add a line to "unclear" saying you assumed it.
3. "a few" is 3, "a couple" is 2. Anything vaguer, use your best guess and list it in "unclear".
4. Run types: easy, long, tempo, intervals, race, trail. Lift types: push, pull, legs, upper, lower, full body.
5. Distances are in the unit given. Pace is per that unit.
6. Omit any section the sentence does not mention: use null, not an empty guess.
7. Never add anything that was not said.`;

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { error: "POST only" });
    const db = admin();
    const user = await userFromRequest(event, db);
    if (!user) return json(401, { error: "Not signed in." });
    if (!groqReady()) return json(503, { error: "Voice logging is not set up: no AI key is set in Netlify (AI_API_KEY or GROQ_API_KEY)." });

    const body = JSON.parse(event.body || "{}");
    const { audio, mime, presets = [], unit = "mi", text } = body;

    // either send audio to transcribe, or text straight through (useful for testing)
    let transcript = (text || "").trim();
    if (!transcript) {
      if (!audio) return json(400, { error: "No audio." });
      if (audio.length > 8_000_000) return json(413, { error: "That recording is too long — keep it under about a minute." });
      transcript = await transcribe(audio, mime || "audio/webm");
    }
    if (!transcript) return json(200, { transcript: "", parsed: null, error: "Nothing was heard." });

    const presetList = presets.slice(0, 40).map((p) => `${p.id}: ${p.label} (${p.kind}, ${p.amount}${p.unit === "mg" ? "mg" : ` ${p.unit}`})`).join("\n");
    const parsed = await chatJson(
      SYSTEM,
      `Distance unit: ${unit}\n\nAvailable chips:\n${presetList}\n\nSpoken sentence:\n"${transcript}"`,
      { temperature: 0.1, maxTokens: 700 }
    );
    return json(200, { transcript, parsed });
  } catch (e) {
    console.error("voice-log:", e?.message || e);
    return json(500, { error: String(e.message || e) });
  }
}
