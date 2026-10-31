"use client";

import Image from "next/image";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useParams, useRouter } from "next/navigation";

function InvitationAccept() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setMessage("");
    const response = await fetch("/api/invitations/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: params.token }) });
    const result = await response.json();
    if (!response.ok) setMessage(result.error ?? "Unable to accept this invitation.");
    else router.push("/");
    setBusy(false);
  }

  return <section className="invite-panel"><Image src="/collabry-mark.svg" alt="Collabry" width={42} height={42} priority /><p className="overline">COLLABRY INVITATION</p><h1>You&apos;ve been invited to collaborate.</h1><p>Join the project workspace and keep the work connected to the people doing it.</p><button className="new-project" onClick={accept} disabled={busy}>{busy ? "Accepting..." : "Accept invitation"}</button>{message && <p className="invite-error" role="status">{message}</p>}<Link href="/login">Sign in with a different account</Link></section>;
}

export default function InvitationPage() {
  return <main className="invite-page"><Suspense fallback={<section className="invite-panel"><p className="overline">COLLABRY INVITATION</p><h1>Loading invitation...</h1></section>}><InvitationAccept /></Suspense></main>;
}
