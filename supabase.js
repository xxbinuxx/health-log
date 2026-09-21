import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config";

export const configured = SUPABASE_URL.startsWith("https://") && SUPABASE_ANON_KEY.length > 20;

export const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
