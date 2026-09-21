// Key/value storage on top of one Supabase table (hl_store).
// Same shape as the storage the Claude artifact used, so App.jsx barely changed.
 
import { supabase } from "./supabase";
 
async function userId() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}
 
function explain(error) {
  const msg = error?.message || String(error);
  if (/relation .*hl_store.* does not exist|Could not find the table/i.test(msg)) return "The hl_store table does not exist. Run supabase.sql in the SQL Editor (SETUP.md step 3.4).";
  if (/row-level security|permission denied/i.test(msg)) return "The database refused the write. Re-run supabase.sql so the 'own rows' policy exists.";
  if (/JWT|apikey|Invalid API key/i.test(msg)) return "The anon key in config.js is not accepted. Copy it again from Project Settings → API.";
  return msg;
}
 
export const store = {
  lastError: null,
  async get(key) {
    try {
      const uid = await userId();
      if (!uid) return null;
      const { data, error } = await supabase.from("hl_store").select("value").eq("user_id", uid).eq("key", key).maybeSingle();
      if (error) { store.lastError = explain(error); console.error("storage.get", key, error); return null; }
      return data ? data.value : null;
    } catch (e) { store.lastError = explain(e); console.error("storage.get", key, e); return null; }
  },
  async set(key, value) {
    try {
      const uid = await userId();
      if (!uid) { store.lastError = "Not signed in."; return false; }
      const { error } = await supabase.from("hl_store")
        .upsert({ user_id: uid, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
      if (error) { store.lastError = explain(error); console.error("storage.set", key, error); return false; }
      store.lastError = null;
      return true;
    } catch (e) { store.lastError = explain(e); console.error("storage.set", key, e); return false; }
  },
};
