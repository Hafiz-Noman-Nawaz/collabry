"use client";

import { FormEvent, Suspense, useState } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";

function LoginForm() {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();
  const nextPath = searchParams.get("next");
  const safeNext = nextPath?.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      const supabase = createClient();
      const result = mode === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: `${window.location.origin}/auth/callback` } });

      if (result.error) throw result.error;
      setMessage(mode === "login" ? "Signed in. Redirecting to your workspace..." : "Check your email to verify your account before signing in.");
      if (mode === "login") router.push(safeNext);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to complete that request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <section className="auth-panel">
        <div className="auth-brand"><Image src="/collabry-mark.svg" alt="Collabry" width={34} height={34} priority /> <span>Collabry</span></div>
        <p className="eyebrow">Project collaboration for university teams</p>
        <h1>{mode === "login" ? "Welcome back." : "Create your account."}</h1>
        <p className="auth-copy">Tasks, meetings, files and messages for your project team, in one place.</p>
        <form onSubmit={submit} className="auth-form">
          {mode === "signup" && <label>Full name<input required value={fullName} onChange={(event) => setFullName(event.target.value)} autoComplete="name" /></label>}
          <label>Email address<input required type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
          <label>Password<input required minLength={8} type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} /></label>
          <button className="auth-submit" disabled={busy}>{busy ? "Working..." : mode === "login" ? "Sign in" : "Create account"}</button>
        </form>
        {message && <p className="auth-message" role="status">{message}</p>}
        <button className="auth-switch" onClick={() => { setMode(mode === "login" ? "signup" : "login"); setMessage(""); }}>{mode === "login" ? "New to Collabry? Create an account" : "Already have an account? Sign in"}</button>
      </section>
      <aside className="auth-aside"><span className="aside-kicker">COLLABRY WORKSPACE</span><h2>Everything your project team needs, in one place.</h2><p>Plan tasks, schedule meetings, share files and keep decisions next to the work they belong to.</p><div className="aside-rule" /><small>Built for final-year project teams and research groups.</small></aside>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<main className="auth-loading"><div className="auth-loading-spinner" /><span>Loading...</span></main>}>
      <LoginForm />
    </Suspense>
  );
}
