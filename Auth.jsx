import React, { useState } from "react";
import { supabase, configured } from "./supabase";

const css = `
.auth{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#EDF0EA;color:#17211C;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:14px;padding:24px;}
.auth .card{background:#F8FAF6;border:1px solid #C7D1C6;padding:26px 24px;width:100%;max-width:360px;}
.auth h1{font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;font-weight:400;font-size:26px;margin:0 0 6px;}
.auth p{color:#5C6B61;font-size:13px;line-height:1.5;margin:0 0 16px;}
.auth input{font:inherit;font-size:15px;padding:9px 10px;border:1px solid #C7D1C6;border-radius:2px;width:100%;
  background:#fff;color:#17211C;box-sizing:border-box;}
.auth input:focus{outline:2px solid #33507C;outline-offset:-1px;}
.auth button{margin-top:10px;width:100%;background:#17211C;color:#F8FAF6;border:none;padding:10px;font:inherit;font-size:14px;
  cursor:pointer;border-radius:2px;}
.auth button:disabled{opacity:.5;cursor:default;}
.auth .ok{color:#2E6B4F;} .auth .bad{color:#BE4A2B;}
.auth code{background:#DEE5DC;padding:1px 5px;border-radius:2px;font-size:12px;}
`;

export default function Auth() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState("idle"); // idle | sending | sent | error
  const [err, setErr] = useState("");

  const send = async () => {
    if (!email.includes("@")) return;
    setState("sending"); setErr("");
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    });
    if (error) { setErr(error.message); setState("error"); } else setState("sent");
  };

  return (
    <div className="auth">
      <style>{css}</style>
      <div className="card">
        <h1>Health log</h1>
        {!configured ? (
          <p className="bad">
            The app is not connected to a database yet. Open <code>config.js</code> and paste in your
            Supabase project URL and anon key (SETUP.md, step 4), then let Netlify rebuild.
          </p>
        ) : state === "sent" ? (
          <p className="ok">Check your email for a sign-in link. Open it on this device and you'll land back here, signed in.</p>
        ) : (
          <>
            <p>Enter your email and we'll send a one-time sign-in link. No password.</p>
            <input type="email" value={email} placeholder="you@example.com" autoComplete="email"
                   onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
            <button onClick={send} disabled={state === "sending" || !email.includes("@")}>
              {state === "sending" ? "Sending…" : "Send sign-in link"}
            </button>
            {err && <p className="bad" style={{ marginTop: 10 }}>{err}</p>}
          </>
        )}
      </div>
    </div>
  );
}
