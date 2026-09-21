import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { supabase, configured } from "./supabase";
import Auth from "./Auth";
import HealthLog from "./App";

function Root() {
  const [session, setSession] = useState(undefined); // undefined = still checking

  useEffect(() => {
    if (!configured) { setSession(null); return; }
    supabase.auth.getSession().then(({ data }) => setSession(data.session ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  if (session === undefined) return null;
  if (!session) return <Auth />;
  return <HealthLog email={session.user.email} onSignOut={() => supabase.auth.signOut()} />;
}

createRoot(document.getElementById("root")).render(<Root />);
