"use client";

import { useState } from "react";

export function ApplyLink({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  const url = typeof window === "undefined" ? `/apply/${token}` : `${window.location.origin}/apply/${token}`;
  return (
    <section className="panel stack" aria-label="Application link">
      <h2>Application link</h2>
      <p className="muted">Send this link to truckers. They fill in the form and upload truck photos without signing in.</p>
      <div className="actions">
        <input className="input" readOnly value={url} aria-label="Application link" onFocus={(e) => e.currentTarget.select()} style={{ flex: 1, minWidth: 200 }} />
        <button
          className="btn btn-ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {}
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </section>
  );
}
