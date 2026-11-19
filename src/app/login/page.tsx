import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { CheckIcon } from "@/components/icons";
import { Logo } from "@/components/logo";
import { SESSION_COOKIE, resolveActor } from "@/server/auth/sessions";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

/** Sends already-signed-in users to the workspace. Reads cookies, so it streams inside Suspense. */
async function RedirectIfSignedIn() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (await resolveActor(token)) redirect("/app");
  return null;
}

export default function LoginPage() {
  return (
    <div className="auth">
      <Suspense fallback={null}>
        <RedirectIfSignedIn />
      </Suspense>
      <aside className="auth-side">
        <div style={{ color: "#fff" }}>
          <Logo />
        </div>
        <div>
          <h2>Every load, every proof, one place.</h2>
          <p>Sign in to dispatch trips, track deliveries and approve proof of delivery.</p>
        </div>
        <div className="auth-quote">
          {["Company data is isolated at the database level", "Contract rates are never shown to drivers", "Every approval is recorded in an audit trail"].map(
            (t) => (
              <div className="auth-stat" key={t}>
                <CheckIcon size={18} /> {t}
              </div>
            ),
          )}
        </div>
      </aside>

      <main className="auth-main">
        <div className="auth-card">
          <Logo />
          <h1>Welcome back</h1>
          <p className="sub">Sign in to your Truckwise workspace.</p>
          <LoginForm />
          <p className="auth-foot">
            Truckwise is the dispatch system for Lalolu Trucking staff and approved partners. Ask an administrator if you need access.
          </p>
        </div>
      </main>
    </div>
  );
}
