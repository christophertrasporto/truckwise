/**
 * SMS behind an adapter. The default is a STUB that sends nothing (it only remembers messages in memory, for
 * tests). Semaphore and Twilio clients exist and are selected by SMS_PROVIDER with their credentials, but have
 * only been exercised against a fake server, never a real account.
 */
export type SmsResult = { ok: true; providerId?: string } | { ok: false; retryable: boolean; detail: string };

export interface SmsProvider {
  readonly name: string;
  /** True when messages are really sent to phones. False for the stub. */
  readonly real: boolean;
  send(toE164: string, text: string): Promise<SmsResult>;
}

export const stubSent: { to: string; text: string }[] = [];

export const stubSms: SmsProvider = {
  name: "stub",
  real: false,
  async send(to, text) {
    stubSent.push({ to, text });
    return { ok: true, providerId: "stub" };
  },
};

const retryableStatus = (s: number) => s === 429 || s >= 500;

async function post(url: string, init: RequestInit): Promise<SmsResult & { json?: unknown }> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return { ok: false, retryable: true, detail: `network error: ${e instanceof Error ? e.message : "unknown"}` };
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = typeof json === "object" && json && "message" in json ? String((json as { message: unknown }).message) : `HTTP ${res.status}`;
    return { ok: false, retryable: retryableStatus(res.status), detail: msg.slice(0, 300) };
  }
  return { ok: true, json };
}

export function semaphoreSms(apiKey: string, senderName: string | undefined, baseUrl = "https://api.semaphore.co"): SmsProvider {
  return {
    name: "semaphore",
    real: true,
    async send(to, text) {
      const body = new URLSearchParams({ apikey: apiKey, number: to.replace(/^\+/, ""), message: text });
      if (senderName) body.set("sendername", senderName);
      const r = await post(`${baseUrl}/api/v4/messages`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
      if (!r.ok) return r;
      const first = Array.isArray(r.json) ? (r.json[0] as { message_id?: number | string } | undefined) : undefined;
      return { ok: true, providerId: first?.message_id !== undefined ? String(first.message_id) : undefined };
    },
  };
}

export function twilioSms(accountSid: string, authToken: string, from: string, baseUrl = "https://api.twilio.com"): SmsProvider {
  return {
    name: "twilio",
    real: true,
    async send(to, text) {
      const body = new URLSearchParams({ To: to, From: from, Body: text });
      const r = await post(`${baseUrl}/2010-04-01/Accounts/${accountSid}/Messages.json`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}` },
        body,
      });
      if (!r.ok) return r;
      const sid = typeof r.json === "object" && r.json && "sid" in r.json ? String((r.json as { sid: unknown }).sid) : undefined;
      return { ok: true, providerId: sid };
    },
  };
}

let override: SmsProvider | null = null;
/** Tests swap the provider here. */
export const setSmsProvider = (p: SmsProvider | null) => void (override = p);

export function getSmsProvider(): SmsProvider {
  if (override) return override;
  const kind = process.env.SMS_PROVIDER;
  if (kind === "semaphore" && process.env.SEMAPHORE_API_KEY) {
    return semaphoreSms(process.env.SEMAPHORE_API_KEY, process.env.SEMAPHORE_SENDER_NAME || undefined, process.env.SEMAPHORE_BASE_URL || undefined);
  }
  if (kind === "twilio" && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
    return twilioSms(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, process.env.TWILIO_FROM, process.env.TWILIO_BASE_URL || undefined);
  }
  return stubSms;
}
