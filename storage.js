// Key/value storage on top of one Supabase table (hl_store).
// Same shape as the storage the Claude artifact used, so App.jsx barely changed.

import { supabase } from "./supabase";

async function userId() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

export const store = {
  async get(key) {
    try {
      const uid = await userId();
      if (!uid) return null;
      const { data, error } = await supabase.from("hl_store").select("value").eq("user_id", uid).eq("key", key).maybeSingle();
      if (error) { console.error("storage.get", key, error.message); return null; }
      return data ? data.value : null;
    } catch (e) { console.error("storage.get", key, e); return null; }
  },
  async set(key, value) {
    try {
      const uid = await userId();
      if (!uid) return false;
      const { error } = await supabase.from("hl_store")
        .upsert({ user_id: uid, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
      if (error) { console.error("storage.set", key, error.message); return false; }
      return true;
    } catch (e) { console.error("storage.set", key, e); return false; }
  },
};
