import type { Metadata } from "next";
import { requireSignedIn } from "@/server/auth/current";
import { NotificationSettings } from "./notification-settings";
import { PasswordForm } from "./password-form";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  await requireSignedIn();
  return (
    <div className="stack" style={{ maxWidth: 520 }}>
      <div className="page-head">
        <h1>Account</h1>
      </div>
      <NotificationSettings />
      <PasswordForm />
    </div>
  );
}
