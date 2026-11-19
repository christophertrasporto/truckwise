import type { Metadata } from "next";
import { Suspense } from "react";
import { Logo } from "@/components/logo";
import { companyForToken } from "@/server/services/applications";
import { ApplyForm } from "./apply-form";

export const metadata: Metadata = { title: "Apply as a subcontractor", robots: { index: false, follow: false } };

async function Body({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const company = await companyForToken(token);
  if (!company) {
    return (
      <div className="panel stack">
        <h1>This link is not valid</h1>
        <p className="muted">Ask the trucking company for a new application link.</p>
      </div>
    );
  }
  return <ApplyForm token={token} />;
}

export default function ApplyPage({ params }: { params: Promise<{ token: string }> }) {
  return (
    <main className="wrap stack" style={{ maxWidth: 720, margin: "0 auto", padding: "24px 16px" }}>
      <Logo />
      <Suspense fallback={<div className="panel">Loading…</div>}>
        <Body params={params} />
      </Suspense>
    </main>
  );
}
