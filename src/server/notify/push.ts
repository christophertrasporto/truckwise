import webpush from "web-push";

/**
 * Web Push behind an adapter. Needs VAPID keys (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT); without them
 * push is "not configured" and notifications are in-app only (plus SMS for urgent ones, where enabled).
 *
 * The request is built by the web-push library (encryption and VAPID signature) and sent with fetch.
 * Not yet exercised against a real browser push service.
 */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}
export interface PushPayload {
  title: string;
  body: string;
  link: string | null;
  /** The notification id: a browser replaces an earlier notification with the same tag instead of stacking a duplicate. */
  tag: string;
}
export type PushResult = { status: "sent" } | { status: "gone" } | { status: "error"; retryable: boolean; detail: string };

export interface PushSender {
  configured(): boolean;
  send(target: PushTarget, payload: PushPayload, urgent: boolean): Promise<PushResult>;
}

export const vapidPublicKey = () => process.env.VAPID_PUBLIC_KEY || null;

const realSender: PushSender = {
  configured: () => !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT),
  async send(target, payload, urgent) {
    let details: ReturnType<typeof webpush.generateRequestDetails>;
    try {
      details = webpush.generateRequestDetails({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } }, JSON.stringify(payload), {
        TTL: 3600,
        urgency: urgent ? "high" : "normal",
        vapidDetails: { subject: process.env.VAPID_SUBJECT!, publicKey: process.env.VAPID_PUBLIC_KEY!, privateKey: process.env.VAPID_PRIVATE_KEY! },
      });
    } catch (e) {
      return { status: "error", retryable: false, detail: `bad subscription or keys: ${e instanceof Error ? e.message : "unknown"}` };
    }
    let res: Response;
    try {
      res = await fetch(details.endpoint, { method: "POST", headers: details.headers as Record<string, string>, body: details.body as BodyInit, signal: AbortSignal.timeout(15_000) });
    } catch (e) {
      return { status: "error", retryable: true, detail: `network error: ${e instanceof Error ? e.message : "unknown"}` };
    }
    if (res.status >= 200 && res.status < 300) return { status: "sent" };
    if (res.status === 404 || res.status === 410) return { status: "gone" }; // the device unsubscribed: forget it
    return { status: "error", retryable: res.status === 429 || res.status >= 500, detail: `push service answered ${res.status}` };
  },
};

let override: PushSender | null = null;
/** Tests swap the sender here. */
export const setPushSender = (s: PushSender | null) => void (override = s);
export const getPushSender = (): PushSender => override ?? realSender;
