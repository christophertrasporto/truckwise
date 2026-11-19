"use client";

import { useEffect, useState, type FormEvent } from "react";
import { post } from "@/components/api";
import { formatPhPhone } from "@/shared/phone";

interface Status {
  phone: string | null;
  smsEnabled: boolean;
  devices: number;
  pushConfigured: boolean;
  vapidPublicKey: string | null;
  smsProviderIsReal: boolean;
}

const toKey = (b64: string) => {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
};

/** Where alerts reach this person besides the Alerts page: this device (Web Push) and, for urgent items, a text message. */
export function NotificationSettings() {
  const [s, setS] = useState<Status | null>(null);
  const [phone, setPhone] = useState("");
  const [sms, setSms] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [supported, setSupported] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const res = await fetch("/api/notification-settings", { cache: "no-store" }).catch(() => null);
      if (!res?.ok || !alive) return;
      const st: Status = await res.json();
      setS(st);
      setPhone(st.phone ? formatPhPhone(st.phone) : "");
      setSms(st.smsEnabled);
      // Push needs the service worker, which only runs in the installed/production app.
      const ok = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && process.env.NODE_ENV === "production";
      setSupported(ok);
      if (ok) {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager.getSubscription();
        if (alive) setPushOn(!!sub);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  async function turnOnPush() {
    if (!s?.vapidPublicKey) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") throw new Error("Notifications were not allowed in this browser. Change that in the browser's site settings and try again.");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(s.vapidPublicKey) });
      const json = sub.toJSON();
      const res = await post("/api/push/subscription", { endpoint: json.endpoint, keys: json.keys });
      if (!res.ok) throw new Error(res.error ?? "Could not save this device.");
      setPushOn(true);
      setMsg("Alerts are on for this device.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not turn alerts on.");
    }
    setBusy(false);
  }

  async function turnOffPush() {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await fetch("/api/push/subscription", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: sub.endpoint }) });
        await sub.unsubscribe();
      }
      setPushOn(false);
      setMsg("Alerts are off for this device.");
    } catch {
      setError("Could not turn alerts off.");
    }
    setBusy(false);
  }

  async function saveSms(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/notification-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone: phone.trim() || null, smsEnabled: sms }) });
      const json = await res.json().catch(() => null);
      if (!res.ok) setError(json?.error ?? "Could not save.");
      else {
        setPhone(json.phone ? formatPhPhone(json.phone) : "");
        setMsg("Saved.");
      }
    } catch {
      setError("Cannot reach the server.");
    }
    setBusy(false);
  }

  if (!s) return null;
  return (
    <section className="panel stack" aria-labelledby="alerts-settings">
      <h2 id="alerts-settings">Alerts</h2>
      <p className="muted">Everything always appears on the Alerts page. You can also be alerted on this device, and by text message when something urgent is waiting.</p>
      {error && <div className="alert" role="alert">{error}</div>}
      {msg && <div className="notice ok-note" role="status">{msg}</div>}

      <div className="stack" style={{ gap: 8 }}>
        <b>On this device</b>
        {!s.pushConfigured ? (
          <p className="muted">Phone alerts are not set up on this server yet. Ask the administrator.</p>
        ) : !supported ? (
          <p className="muted">Available in the installed app (or any secure production site) on a browser that supports it.</p>
        ) : pushOn ? (
          <div className="actions">
            <span className="chip chip-ok">On</span>
            <button className="btn btn-ghost btn-sm" onClick={turnOffPush} disabled={busy}>Turn off</button>
          </div>
        ) : (
          <div><button className="btn btn-primary btn-sm" onClick={turnOnPush} disabled={busy}>Turn on alerts on this device</button></div>
        )}
      </div>

      <form onSubmit={saveSms} className="stack" noValidate>
        <b>Text messages for urgent items</b>
        {!s.smsProviderIsReal && <p className="muted">Text messages are not connected on this server yet, so nothing is sent for now. You can still save your number.</p>}
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="phone">Mobile number</label>
          <input id="phone" className="input" inputMode="tel" autoComplete="tel" placeholder="0917 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={sms} onChange={(e) => setSms(e.target.checked)} />
          <span>Text me when something urgent is waiting and an alert did not reach my device</span>
        </label>
        <div><button className="btn btn-primary btn-sm" disabled={busy}>Save</button></div>
      </form>
    </section>
  );
}
