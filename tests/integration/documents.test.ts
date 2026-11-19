import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb } from "@/server/db";
import { customers, tripDocumentFiles, trips } from "@/server/db/schema";
import { addDocumentType, addTripDocument, getChecklist, removeTripDocument, reviewDocument, updateDocumentType, uploadDocument, waiveDocument } from "@/server/services/documents";
import { claimTrip, createOffer } from "@/server/services/offers";
import { partnerAccept } from "@/server/services/partner";
import { reviewPod, submitPod as submitRaw } from "@/server/services/pod";
import { updateSettings } from "@/server/services/settings";
import { advanceTrip, createTrip, type TenantActor } from "@/server/services/trips";
import { PNG, actorFor, admin, drain, tripInput, truckIdOf } from "../helpers";

let owner: TenantActor, dispatcher: TenantActor, driver: TenantActor, bayanOwner: TenantActor, partnerOwner: TenantActor, partnerDriver: TenantActor;
let acmeTruck: string, partnerTruck: string;
let n = 0;
const key = () => `doc-${Date.now()}-${n++}-${Math.random().toString(36).slice(2, 8)}`;
const file = (name = "doc.png") => ({ name, data: PNG });

beforeAll(async () => {
  owner = await actorFor("owner@acme.test");
  dispatcher = await actorFor("dispatcher@acme.test");
  driver = await actorFor("driver@acme.test");
  bayanOwner = await actorFor("owner@bayan.test");
  partnerOwner = await actorFor("owner@santos.test");
  partnerDriver = await actorFor("driver@santos.test");
  acmeTruck = await truckIdOf(owner.tenantId, "ACM-101");
  partnerTruck = await truckIdOf(partnerOwner.tenantId, "STS-201");
  await updateSettings(owner, { claimMode: "immediate", podAutoApprove: false, vatBps: 0 });
});
afterAll(async () => {
  await closeDb();
  await admin.sql.end();
});

/** A client of its own, so other tests' trips are never asked for paperwork. */
async function client(types: { name: string; required?: boolean; uploader?: "driver" | "dispatcher" | "either" }[]) {
  const [c] = await admin.db.insert(customers).values({ tenantId: owner.tenantId, name: `Doc Client ${key()}`, address: "Makati" }).returning();
  for (const t of types) await addDocumentType(owner, c.id, { name: t.name, required: t.required ?? true, uploader: t.uploader ?? "either" });
  return c.id;
}

/** A trip taken to the destination by the company's driver (or the subcontractor's), proof approved. */
async function deliveredTrip(customerId: string, partner = false) {
  const id = (await createTrip(dispatcher, tripInput(customerId))).id;
  const worker = partner ? partnerDriver : driver;
  if (partner) {
    await createOffer(dispatcher, id, { mode: "broadcast_partners" });
    await partnerAccept(partnerOwner, owner.tenantId, id, { truckId: partnerTruck, driverUserId: partnerDriver.userId });
  } else {
    await createOffer(dispatcher, id, { mode: "broadcast_internal" });
    await claimTrip(driver, id, { truckId: acmeTruck });
  }
  for (const to of ["started", "arrived_pickup", "loaded", "in_transit", "arrived_destination"] as const) await advanceTrip(worker, id, to);
  return { id, worker };
}
async function approvedProof(id: string, worker: TenantActor) {
  const r = await submitRaw(worker, id, { outcome: "complete", receiverName: "Maria", actualDeliveryAt: new Date(Date.now() - 3600_000).toISOString(), gpsConsent: "unavailable", idempotencyKey: key() }, [file("r.png"), { ...file("s.png"), kind: "signature" as const }]);
  await drain();
  await reviewPod(dispatcher, r.submissionId, { decision: "approve" });
}
const status = async (id: string) => (await admin.db.select().from(trips).where(eq(trips.id, id)))[0].status;

describe("customising what each client needs", () => {
  it("lets only the owner and operations manager set the list, and copies it onto new trips only", async () => {
    const cid = await client([{ name: "Signed delivery receipt" }]);
    await expect(addDocumentType(dispatcher, cid, { name: "Gate pass" })).rejects.toThrow(/Forbidden/);
    await expect(addDocumentType(driver, cid, { name: "Gate pass" })).rejects.toThrow(/Forbidden/);

    const before = (await createTrip(dispatcher, tripInput(cid))).id;
    await addDocumentType(owner, cid, { name: "Weighing scale ticket", required: false, instructions: "Stamped by the scale" });
    const after = (await createTrip(dispatcher, tripInput(cid))).id;

    expect((await getChecklist(dispatcher, before)).items.map((i) => i.name)).toEqual(["Signed delivery receipt"]);
    const items = (await getChecklist(dispatcher, after)).items;
    expect(items.map((i) => i.name)).toEqual(["Signed delivery receipt", "Weighing scale ticket"]);
    expect(items[1]).toMatchObject({ required: false, instructions: "Stamped by the scale" });
  });

  it("switches an item off for future trips without touching booked ones", async () => {
    const cid = await client([{ name: "Gate pass" }, { name: "Toll receipts" }]);
    const booked = (await createTrip(dispatcher, tripInput(cid))).id;
    const types = await admin.db.query.customerDocumentTypes.findMany({ where: (t, { eq: e }) => e(t.customerId, cid) });
    await updateDocumentType(owner, types.find((t) => t.name === "Toll receipts")!.id, { active: false });
    const next = (await createTrip(dispatcher, tripInput(cid))).id;
    expect((await getChecklist(owner, booked)).items).toHaveLength(2);
    expect((await getChecklist(owner, next)).items.map((i) => i.name)).toEqual(["Gate pass"]);
  });

  it("keeps another company's checklist out of reach", async () => {
    const cid = await client([{ name: "Signed delivery receipt" }]);
    const id = (await createTrip(dispatcher, tripInput(cid))).id;
    await expect(getChecklist(bayanOwner, id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("a trip cannot be billed until the client's required documents are approved", () => {
  it("holds the trip after proof is approved, then releases it when every required document is in", async () => {
    const cid = await client([{ name: "Signed receipt", uploader: "driver" }, { name: "Weighing ticket", uploader: "dispatcher" }, { name: "Photo of seal", required: false }]);
    const { id, worker } = await deliveredTrip(cid);
    await approvedProof(id, worker);
    expect(await status(id)).toBe("pod_submitted"); // proof is fine, paperwork is not
    let view = await getChecklist(dispatcher, id);
    expect(view.outstanding).toEqual(["Signed receipt", "Weighing ticket"]);

    const [receipt, ticket] = view.items;
    // the driver uploads theirs but not dispatch's
    await expect(uploadDocument(driver, id, ticket.id, file())).rejects.toMatchObject({ status: 403 });
    await uploadDocument(driver, id, receipt.id, file("receipt.png"));
    await expect(uploadDocument(driver, id, receipt.id, file())).rejects.toMatchObject({ status: 409 }); // waiting for review
    await uploadDocument(dispatcher, id, ticket.id, file("ticket.png"));

    view = await getChecklist(dispatcher, id);
    expect(view.items.map((i) => i.state)).toEqual(["pending", "pending", "missing"]);
    await reviewDocument(dispatcher, view.items[0].latest!.id, { decision: "approve" });
    expect(await status(id)).toBe("pod_submitted");
    await reviewDocument(dispatcher, view.items[1].latest!.id, { decision: "approve" });
    expect(await status(id)).toBe("ready_for_invoice"); // the optional seal photo does not block
  });

  it("sends a rejected document back with a reason, and keeps every version", async () => {
    const cid = await client([{ name: "Signed receipt" }]);
    const { id, worker } = await deliveredTrip(cid);
    await approvedProof(id, worker);
    const doc = (await getChecklist(dispatcher, id)).items[0];
    await uploadDocument(driver, id, doc.id, file("blurry.png"));
    const first = (await getChecklist(dispatcher, id)).items[0].latest!;
    await expect(reviewDocument(dispatcher, first.id, { decision: "reject" })).rejects.toMatchObject({ status: 400 });
    await reviewDocument(dispatcher, first.id, { decision: "reject", note: "Too blurry to read" });
    let item = (await getChecklist(driver, id)).items[0];
    expect(item).toMatchObject({ state: "rejected", canUpload: true });
    expect(item.latest?.reviewNote).toBe("Too blurry to read");

    await uploadDocument(driver, id, doc.id, file("clear.png"));
    item = (await getChecklist(dispatcher, id)).items[0];
    expect(item.versions).toBe(2);
    expect(item.latest?.version).toBe(2);
    expect(await admin.db.select().from(tripDocumentFiles).where(eq(tripDocumentFiles.documentId, doc.id))).toHaveLength(2);
    // an upload is evidence: it cannot be edited in place
    await expect(admin.db.update(tripDocumentFiles).set({ sha256: "x" }).where(eq(tripDocumentFiles.id, first.id))).rejects.toThrow();
    await expect(admin.db.delete(tripDocumentFiles).where(eq(tripDocumentFiles.id, first.id))).rejects.toThrow();
  });

  it("lets the owner waive a required document with a reason, but not a dispatcher", async () => {
    const cid = await client([{ name: "Gate pass" }]);
    const { id, worker } = await deliveredTrip(cid);
    await approvedProof(id, worker);
    const doc = (await getChecklist(dispatcher, id)).items[0];
    await expect(waiveDocument(dispatcher, doc.id, { reason: "Client said skip it" })).rejects.toThrow(/Forbidden/);
    await expect(waiveDocument(owner, doc.id, { reason: "" })).rejects.toThrow();
    await waiveDocument(owner, doc.id, { reason: "Client waived the gate pass" });
    expect(await status(id)).toBe("ready_for_invoice");
    expect((await getChecklist(owner, id)).items[0]).toMatchObject({ state: "waived", waiveReason: "Client waived the gate pass" });
  });

  it("lets dispatch add or remove an item for one trip, and freezes the list once the trip is closed", async () => {
    const cid = await client([{ name: "Signed receipt" }]);
    const { id, worker } = await deliveredTrip(cid);
    await approvedProof(id, worker);
    const extra = await addTripDocument(dispatcher, id, { name: "Customs release", required: true });
    expect((await getChecklist(dispatcher, id)).outstanding).toEqual(["Signed receipt", "Customs release"]);
    await removeTripDocument(dispatcher, extra.id);
    const receipt = (await getChecklist(dispatcher, id)).items[0];
    await uploadDocument(dispatcher, id, receipt.id, file());
    await reviewDocument(dispatcher, (await getChecklist(dispatcher, id)).items[0].latest!.id, { decision: "approve" });
    expect(await status(id)).toBe("ready_for_invoice");
    await expect(addTripDocument(dispatcher, id, { name: "Too late" })).rejects.toMatchObject({ status: 409 });
  });

  it("does not hold a trip whose client needs nothing", async () => {
    const cid = await client([]);
    const { id, worker } = await deliveredTrip(cid);
    await approvedProof(id, worker);
    expect(await status(id)).toBe("ready_for_invoice");
  });

  it("accepts an upload from the subcontractor's driver on a partner trip", async () => {
    const cid = await client([{ name: "Signed receipt" }]);
    const { id, worker } = await deliveredTrip(cid, true);
    await approvedProof(id, worker);
    const doc = (await getChecklist(partnerDriver, id)).items[0];
    expect(doc.canUpload).toBe(true);
    await uploadDocument(partnerDriver, id, doc.id, file("sub-receipt.png"));
    await reviewDocument(dispatcher, (await getChecklist(dispatcher, id)).items[0].latest!.id, { decision: "approve" });
    expect(await status(id)).toBe("ready_for_invoice");
    // a different company's driver sees nothing
    await expect(getChecklist(await actorFor("driver@acme.test"), id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("what may be uploaded", () => {
  it("accepts photos and PDFs, and refuses other files, infected files and uploads before arrival", async () => {
    const cid = await client([{ name: "Signed receipt" }]);
    const early = (await createTrip(dispatcher, tripInput(cid))).id;
    const earlyDoc = (await getChecklist(dispatcher, early)).items[0];
    await expect(uploadDocument(dispatcher, early, earlyDoc.id, file())).rejects.toMatchObject({ status: 409 });

    const { id, worker } = await deliveredTrip(cid);
    await approvedProof(id, worker);
    const doc = (await getChecklist(dispatcher, id)).items[0];
    await expect(uploadDocument(driver, id, doc.id, { name: "x.exe", data: Buffer.from("MZ not allowed") })).rejects.toMatchObject({ status: 400 });
    await expect(uploadDocument(driver, id, doc.id, { name: "e.png", data: Buffer.concat([PNG, Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*")]) })).rejects.toMatchObject({ status: 400 });
    await expect(uploadDocument(driver, id, doc.id, { name: "empty.png", data: Buffer.alloc(0) })).rejects.toMatchObject({ status: 400 });
    await uploadDocument(driver, id, doc.id, { name: "scan.pdf", data: Buffer.from("%PDF-1.4\n%fake but starts like a PDF\n") });
    expect((await getChecklist(dispatcher, id)).items[0].latest?.filename).toBe("scan.pdf");
  });
});
