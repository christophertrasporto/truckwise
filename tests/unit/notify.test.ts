import { createECDH, randomBytes } from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import webpush from "web-push";
import { getPushSender } from "@/server/notify/push";
import { getSmsProvider, semaphoreSms, stubSms, twilioSms } from "@/server/notify/sms";
import { msg, isUrgent, type TripFacts } from "@/server/notify/messages";
import { formatPhPhone, normalizePhPhone } from "@/shared/phone";

/** A throwaway HTTP server that records requests and answers with whatever the test says. */
function fakeServer(respond: (req: http.IncomingMessage, body: Buffer) => { status: number; json?: unknown }) {
  const seen: { url: string; headers: http.IncomingHttpHeaders; body: Buffer }[] = [];
  return new Promise<{ base: string; seen: typeof seen; close: () => void }>((resolve) => {
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ url: req.url ?? "", headers: req.headers, body });
        const r = respond(req, body);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(r.json === undefined ? "" : JSON.stringify(r.json));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen, close: () => server.close() }));
  });
}

describe("normalizePhPhone", () => {
  it("accepts the usual ways of writing a Philippine mobile number", () => {
    for (const n of ["09171234567", "9171234567", "639171234567", "+639171234567", "+63 917 123 4567", "0917-123-4567", "(0917) 123 4567"]) {
      expect(normalizePhPhone(n), n).toBe("+639171234567");
    }
    expect(formatPhPhone("+639171234567")).toBe("+63 917 123 4567");
  });

  it("rejects landlines, other countries, wrong lengths and junk", () => {
    for (const n of ["", "12345", "028123456", "+14155552671", "0817123456", "0917123456", "091712345678", "abc"]) expect(normalizePhPhone(n), n).toBeNull();
  });
});

describe("SMS providers", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("the default provider is a stub that really sends nothing", async () => {
    delete process.env.SMS_PROVIDER;
    const p = getSmsProvider();
    expect(p).toBe(stubSms);
    expect(p.real).toBe(false);
  });

  it("Semaphore: form request with key, number without '+', message and sender; maps provider answers", async () => {
    const srv = await fakeServer(() => ({ status: 200, json: [{ message_id: 4242, status: "Pending" }] }));
    try {
      const r = await semaphoreSms("KEY123", "LALOLU", srv.base).send("+639171234567", "Hello driver");
      expect(r).toEqual({ ok: true, providerId: "4242" });
      expect(srv.seen[0].url).toBe("/api/v4/messages");
      const form = new URLSearchParams(srv.seen[0].body.toString());
      expect(Object.fromEntries(form)).toEqual({ apikey: "KEY123", number: "639171234567", message: "Hello driver", sendername: "LALOLU" });
    } finally {
      srv.close();
    }
  });

  it("separates temporary failures (retry) from permanent ones (stop)", async () => {
    let status = 500;
    const srv = await fakeServer(() => ({ status, json: { message: `status ${status}` } }));
    try {
      const sms = semaphoreSms("K", undefined, srv.base);
      expect(await sms.send("+639171234567", "x")).toMatchObject({ ok: false, retryable: true });
      status = 429;
      expect(await sms.send("+639171234567", "x")).toMatchObject({ ok: false, retryable: true });
      status = 400;
      expect(await sms.send("+639171234567", "x")).toMatchObject({ ok: false, retryable: false });
      status = 401;
      expect(await sms.send("+639171234567", "x")).toMatchObject({ ok: false, retryable: false });
    } finally {
      srv.close();
    }
    expect(await semaphoreSms("K", undefined, "http://127.0.0.1:1").send("+639171234567", "x")).toMatchObject({ ok: false, retryable: true }); // nobody listening
  });

  it("Twilio: basic auth and To/From/Body", async () => {
    const srv = await fakeServer(() => ({ status: 201, json: { sid: "SM123" } }));
    try {
      const r = await twilioSms("AC1", "tok", "+15005550006", srv.base).send("+639171234567", "Hi");
      expect(r).toEqual({ ok: true, providerId: "SM123" });
      expect(srv.seen[0].url).toBe("/2010-04-01/Accounts/AC1/Messages.json");
      expect(srv.seen[0].headers.authorization).toBe(`Basic ${Buffer.from("AC1:tok").toString("base64")}`);
      expect(Object.fromEntries(new URLSearchParams(srv.seen[0].body.toString()))).toEqual({ To: "+639171234567", From: "+15005550006", Body: "Hi" });
    } finally {
      srv.close();
    }
  });

  it("picks the provider from the environment and falls back to the stub when credentials are missing", () => {
    process.env.SMS_PROVIDER = "semaphore";
    delete process.env.SEMAPHORE_API_KEY;
    expect(getSmsProvider().name).toBe("stub");
    process.env.SEMAPHORE_API_KEY = "k";
    expect(getSmsProvider()).toMatchObject({ name: "semaphore", real: true });
    process.env.SMS_PROVIDER = "twilio";
    expect(getSmsProvider().name).toBe("stub");
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: "a", TWILIO_AUTH_TOKEN: "b", TWILIO_FROM: "+1" });
    expect(getSmsProvider()).toMatchObject({ name: "twilio", real: true });
  });
});

describe("Web Push sender", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  /** A real subscription's key material: an uncompressed P-256 public key and a 16-byte auth secret. */
  function subscription(endpoint: string) {
    const ecdh = createECDH("prime256v1");
    ecdh.generateKeys();
    return { endpoint, p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
  }
  const configure = () => {
    const k = webpush.generateVAPIDKeys();
    Object.assign(process.env, { VAPID_PUBLIC_KEY: k.publicKey, VAPID_PRIVATE_KEY: k.privateKey, VAPID_SUBJECT: "mailto:ops@lalolu.test" });
  };
  const payload = { title: "New trip available", body: "TR-1: A to B", link: "/app/trips/x", tag: "n1" };

  it("is 'not configured' without VAPID keys", () => {
    delete process.env.VAPID_PUBLIC_KEY;
    expect(getPushSender().configured()).toBe(false);
    configure();
    expect(getPushSender().configured()).toBe(true);
  });

  it("sends an encrypted, VAPID-signed request and maps the push service's answers", async () => {
    configure();
    let status = 201;
    const srv = await fakeServer(() => ({ status }));
    try {
      const target = subscription(`${srv.base}/push/abc`);
      expect(await getPushSender().send(target, payload, true)).toEqual({ status: "sent" });
      const req = srv.seen[0];
      expect(req.url).toBe("/push/abc");
      expect(req.headers["content-encoding"]).toBe("aes128gcm");
      expect(String(req.headers.authorization)).toMatch(/^vapid t=.+, k=.+/);
      expect(req.headers.urgency).toBe("high");
      expect(req.headers.ttl).toBe("3600");
      expect(req.body.length).toBeGreaterThan(100);
      expect(req.body.toString("latin1")).not.toContain("New trip available"); // the payload is encrypted

      status = 410;
      expect(await getPushSender().send(target, payload, false)).toEqual({ status: "gone" });
      status = 404;
      expect(await getPushSender().send(target, payload, false)).toEqual({ status: "gone" });
      status = 503;
      expect(await getPushSender().send(target, payload, false)).toMatchObject({ status: "error", retryable: true });
      status = 400;
      expect(await getPushSender().send(target, payload, false)).toMatchObject({ status: "error", retryable: false });
    } finally {
      srv.close();
    }
  });

  it("treats a broken subscription as a permanent error and an unreachable service as temporary", async () => {
    configure();
    expect(await getPushSender().send({ endpoint: "http://127.0.0.1:1/x", p256dh: "nope", auth: "nope" }, payload, false)).toMatchObject({ status: "error", retryable: false });
    expect(await getPushSender().send(subscription("http://127.0.0.1:1/x"), payload, false)).toMatchObject({ status: "error", retryable: true });
  });
});

describe("notification wording", () => {
  const t: TripFacts = { tripId: "t", hauler: "h", reference: "TR-1001", origin: "Calamba, Laguna", destination: "Taguig City" };

  it("never mentions money, whatever the notification", () => {
    const drafts = [
      msg.offerNew(t), msg.offerDirect(t), msg.offerOpenCall(t), msg.offerClosed(t), msg.offerExpired(t), msg.offerDeclined(t, "Ana"),
      msg.applicationNew(t, "Ana"), msg.applicationApproved(t), msg.applicationDeclined(t, "Closer driver"), msg.tripClaimed(t, "Ana"),
      msg.tripAssigned(t), msg.released(t, "sick"), msg.cancelled(t), msg.arrivedPickup(t, "Ana"), msg.arrivedDestination(t, "Ana"),
      msg.completed(t), msg.invoiceReady(t), msg.podSubmitted(t, 2), msg.podException(t, "partial"), msg.podEscalated(t), msg.podApproved(t, true),
      msg.podRejected(t, "blurry"), msg.podMore(t, "need signature"), msg.settlementIssued("SET-2026-0001"), msg.settlementPaid("SET-2026-0001"),
      msg.expenseSubmitted(t, "Ana"), msg.expenseApproved(t), msg.expenseRejected(t, "personal"),
    ];
    for (const d of drafts) expect(`${d.title} ${d.body}`, d.kind).not.toMatch(/₱|PHP|peso|centavo|contract|payout|rate|profit|margin|\d{1,3}(,\d{3})+/i);
  });

  it("marks only the items that need action as urgent (the ones worth a text message)", () => {
    for (const k of ["offer.new", "offer.direct", "application.approved", "trip.assigned", "assignment.released", "trip.cancelled", "pod.rejected", "pod.more_requested", "pod.exception_escalated"]) expect(isUrgent(k), k).toBe(true);
    for (const k of ["trip.arrived_pickup", "trip.completed", "pod.submitted", "pod.approved", "invoice.ready", "expense.submitted", "offer.closed"]) expect(isUrgent(k), k).toBe(false);
  });
});
