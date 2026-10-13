/* One place that talks to Groq, so every feature shares the same key, model and failure behaviour.

   The rule throughout: our own code computes every number, and the model only ever writes
   words or reads messy text. Nothing here is allowed to do arithmetic on your log. */

import { env } from "./shared.js";

/* Groq speaks the OpenAI wire format, and so do most of its competitors, so the
   provider is just a base URL. If Groq will not let you sign up, point these three
   variables somewhere else and nothing above has to change:

     OpenRouter   AI_BASE_URL=https://openrouter.ai/api/v1   AI_MODEL=meta-llama/llama-3.3-70b-instruct
     Cerebras     AI_BASE_URL=https://api.cerebras.ai/v1     AI_MODEL=llama-3.3-70b
     Together     AI_BASE_URL=https://api.together.xyz/v1    AI_MODEL=meta-llama/Llama-3.3-70B-Instruct-Turbo
     OpenAI       AI_BASE_URL=https://api.openai.com/v1      AI_MODEL=gpt-4o-mini

   Only Groq and OpenAI serve Whisper at these paths, so voice logging needs one of
   those two; everything else works anywhere. */
const API = () => env("AI_BASE_URL") || env("GROQ_BASE_URL") || "https://api.groq.com/openai/v1";
const KEY = () => env("AI_API_KEY") || env("GROQ_API_KEY");
export const MODEL = () => env("AI_MODEL") || env("GROQ_MODEL") || "openai/gpt-oss-120b";
export const groqReady = () => !!KEY();

async function call(path, body, { timeoutMs = 20000 } = {}) {
  if (!groqReady()) throw new Error("No AI key set — add AI_API_KEY (or GROQ_API_KEY) in Netlify");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${API()}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env("GROQ_API_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j?.error?.message || `The model provider returned ${r.status}`);
    return j;
  } finally { clearTimeout(timer); }
}

/** Plain text back. */
export async function chat(system, user, { temperature = 0.6, maxTokens = 400 } = {}) {
  const j = await call("/chat/completions", {
    model: MODEL(),
    temperature,
    max_tokens: maxTokens,
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  return (j.choices?.[0]?.message?.content || "").trim();
}

/** Strict JSON back. Throws rather than returning something half-parsed. */
export async function chatJson(system, user, { temperature = 0.1, maxTokens = 900 } = {}) {
  const j = await call("/chat/completions", {
    model: MODEL(),
    temperature,
    max_tokens: maxTokens,
    response_format: { type: "json_object" },
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  });
  const text = j.choices?.[0]?.message?.content || "";
  try { return JSON.parse(text); }
  catch { throw new Error(`Model did not return JSON: ${text.slice(0, 160)}`); }
}

/** Whisper. Takes a base64 audio blob from the browser. */
export async function transcribe(base64, mime = "audio/webm") {
  if (!groqReady()) throw new Error("No AI key set — add AI_API_KEY (or GROQ_API_KEY) in Netlify");
  const bytes = Buffer.from(base64, "base64");
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), `note.${mime.includes("mp4") ? "mp4" : "webm"}`);
  form.append("model", env("AI_WHISPER_MODEL") || env("GROQ_WHISPER_MODEL") || "whisper-large-v3-turbo");
  form.append("response_format", "json");
  form.append("language", "en");
  const r = await fetch(`${API()}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env("GROQ_API_KEY")}` },
    body: form,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `Transcription returned ${r.status}`);
  return (j.text || "").trim();
}

/** Run a Groq call but never let it break the caller. */
export async function tryGroq(fn, fallback, label = "groq") {
  if (!groqReady()) return fallback;
  try { return await fn(); }
  catch (e) { console.error(`${label}: falling back —`, e?.message || e); return fallback; }
}
