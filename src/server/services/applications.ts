import { assertFeature, entitlementsFor } from "./entitlements";
import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { OTHER, PHOTO_KINDS, photoLabel, reviewApplicationInput, type ApplicationInput, type PhotoKind } from "@/shared/application";
import { writeAudit } from "../audit";
import { withContext, withTenant } from "../db";
import { companySettings, tenants, subconApplicationFiles, subconApplicationTrucks, subconApplications, trucks, users } from "../db/schema";
import { HttpError, isUniqueViolation } from "../errors";
import { emitEvent } from "../notify/events";
import { authorize } from "../policy";
import { getScanner } from "../scan";
import { MAX_FILE_BYTES, sha256, sniffImage, storage } from "../storage";
import { createSubcontractorCompany } from "./partners";
import type { Ctx, TenantActor } from "./trips";
import { z } from "zod";

// ---------------------------------------------------------------------------
// The company's public application link
// ---------------------------------------------------------------------------

/** Returns this company's application link token, creating it the first time. */
export async function getApplyToken(actor: TenantActor): Promise<string> {
  authorize(actor, "partner:read");
  if (actor.tenantKind !== "hauler") throw new HttpError(403, "Only a trucking company takes applications");
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    await assertFeature(db, actor.tenantId, "applications");
    const [s] = await db.select({ t: companySettings.applyToken }).from(companySettings).where(eq(companySettings.tenantId, actor.tenantId));
    if (s?.t) return s.t;
    authorize(actor, "partner:manage");
    const token = randomBytes(18).toString("base64url");
    if (s) await db.update(companySettings).set({ applyToken: token }).where(eq(companySettings.tenantId, actor.tenantId));
    else await db.insert(companySettings).values({ tenantId: actor.tenantId, applyToken: token });
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "application_link.create", entityType: "company_settings", entityId: actor.tenantId });
    return token;
  });
}

/** Who owns this link? Null for an unknown token. Used by the public page before showing the form. */
export async function companyForToken(token: string): Promise<{ tenantId: string } | null> {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  return withContext({ platform: true }, async (db) => {
    const [row] = await db
      .select({ id: companySettings.tenantId, status: tenants.status })
      .from(companySettings)
      .innerJoin(tenants, eq(tenants.id, companySettings.tenantId))
      .where(eq(companySettings.applyToken, token));
    // A suspended company, or one whose plan no longer includes the form, takes no applications.
    if (!row || row.status !== "active") return null;
    if (!(await entitlementsFor(db, row.id)).features.applications) return null;
    return { tenantId: row.id };
  });
}

// ---------------------------------------------------------------------------
// Public submission (no sign-in)
// ---------------------------------------------------------------------------

export interface ApplicationFile {
  /** 0 = the first truck, 1.. = the further trucks in the order they were listed. */
  truck?: number;
  kind: PhotoKind;
  name: string;
  data: Buffer;
}

const hits = new Map<string, number[]>();
/** A small per-address brake against floods: 6 submissions an hour. The database checks below are the real limits. */
function tooManyFromAddress(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > 6;
}

/**
 * Someone applies to become a subcontractor. They are not signed in, so everything here is checked as hostile
 * input: the link token picks the company, every photo is validated by its real content and scanned, and
 * duplicates and floods are refused. Nothing but this one application (and its six photos) is ever written.
 */
export async function submitApplication(token: string, input: ApplicationInput, files: ApplicationFile[], meta: { ip: string }) {
  const company = await companyForToken(token);
  if (!company) throw new HttpError(404, "This application link is not valid");
  if (input.website) return { id: null, received: true as const }; // a bot filled the hidden field: look successful, store nothing
  if (tooManyFromAddress(meta.ip)) throw new HttpError(429, "Too many applications from this connection. Try again later.");

  const trucksIn = [{ plateNumber: input.plateNumber }, ...input.extraTrucks];
  const checked: { truck: number; kind: PhotoKind; name: string; data: Buffer; img: NonNullable<ReturnType<typeof sniffImage>> }[] = [];
  for (let i = 0; i < trucksIn.length; i++) {
    const who = trucksIn.length > 1 ? `Truck ${trucksIn[i].plateNumber}: ` : "";
    const byKind = new Map(files.filter((f) => (f.truck ?? 0) === i).map((f) => [f.kind, f]));
    const missing = PHOTO_KINDS.filter((k) => !byKind.has(k));
    if (missing.length) throw new HttpError(400, `${who}Please add: ${missing.map(photoLabel).join(", ")}`);
    for (const kind of PHOTO_KINDS) {
      const f = byKind.get(kind)!;
      if (f.data.length > MAX_FILE_BYTES) throw new HttpError(400, `${who}${photoLabel(kind)} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
      const img = sniffImage(f.data);
      if (!img) throw new HttpError(400, `${who}${photoLabel(kind)} must be a JPEG, PNG or WebP photo`);
      const scan = await getScanner().scan(f.data);
      if (scan.status === "infected") throw new HttpError(400, `${who}${photoLabel(kind)} failed the security check and was not accepted`);
      if (scan.status === "error") throw new HttpError(503, "We could not check your photos right now. Please try again in a few minutes.");
      checked.push({ truck: i, kind, name: f.name.slice(0, 200), data: f.data, img });
    }
  }

  const id = randomUUID();
  const extraIds = input.extraTrucks.map(() => randomUUID());
  const stored = await Promise.all(
    checked.map(async (c) => {
      const folder = c.truck === 0 ? "" : `t${c.truck}/`;
      const key = `tenants/${company.tenantId}/applications/${id}/${folder}${c.kind}.${c.img.ext}`;
      await storage.put(key, c.data);
      return { truckId: c.truck === 0 ? null : extraIds[c.truck - 1], kind: c.kind, key, name: c.name, mime: c.img.mime, size: c.data.length, hash: sha256(c.data) };
    }),
  );

  try {
    await withContext({ platform: true }, async (db) => {
      const day = new Date(Date.now() - 24 * 3600_000);
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(subconApplications)
        .where(and(eq(subconApplications.tenantId, company.tenantId), eq(subconApplications.email, input.email), gte(subconApplications.createdAt, day)));
      if (n >= 3) throw new HttpError(429, "This email already sent applications today. Please wait for us to review them.");
      const plates = [input.plateNumber, ...input.extraTrucks.map((t) => t.plateNumber)];
      const [open] = await db
        .select({ id: subconApplications.id })
        .from(subconApplications)
        .where(and(eq(subconApplications.tenantId, company.tenantId), inArray(subconApplications.plateNumber, plates), eq(subconApplications.status, "new")));
      const [openExtra] = await db
        .select({ id: subconApplicationTrucks.id })
        .from(subconApplicationTrucks)
        .innerJoin(subconApplications, eq(subconApplications.id, subconApplicationTrucks.applicationId))
        .where(and(eq(subconApplicationTrucks.tenantId, company.tenantId), inArray(subconApplicationTrucks.plateNumber, plates), eq(subconApplications.status, "new")));
      if (open || openExtra) throw new HttpError(409, "An application for one of these plate numbers is already waiting for review.");

      await db.insert(subconApplications).values({
        id,
        tenantId: company.tenantId,
        companyName: input.companyName,
        contactName: input.contactName,
        phone: input.phone,
        email: input.email,
        address: input.address,
        plateNumber: input.plateNumber,
        truckType: input.truckType === OTHER ? `Other: ${input.truckTypeOther}` : input.truckType,
        truckSize: input.truckSize === OTHER ? `Other: ${input.truckSizeOther}` : input.truckSize,
        capacityKg: input.capacityKg,
        driverName: input.driverName,
        licenseNumber: input.licenseNumber,
        licenseExpiry: input.licenseExpiry,
        notes: input.notes,
        submittedFromIp: meta.ip.slice(0, 64),
      });
      if (input.extraTrucks.length) {
        await db.insert(subconApplicationTrucks).values(
          input.extraTrucks.map((t, i) => ({
            id: extraIds[i],
            tenantId: company.tenantId,
            applicationId: id,
            plateNumber: t.plateNumber,
            truckType: t.truckType === OTHER ? `Other: ${t.truckTypeOther}` : t.truckType,
            truckSize: t.truckSize === OTHER ? `Other: ${t.truckSizeOther}` : t.truckSize,
            capacityKg: t.capacityKg,
            driverName: t.driverName,
            licenseNumber: t.licenseNumber,
            licenseExpiry: t.licenseExpiry,
          })),
        );
      }
      await db.insert(subconApplicationFiles).values(
        stored.map((s) => ({ tenantId: company.tenantId, applicationId: id, truckId: s.truckId, kind: s.kind, objectKey: s.key, originalFilename: s.name, mimeType: s.mime, sizeBytes: s.size, sha256: s.hash })),
      );
      await writeAudit(db, { tenantId: company.tenantId, actorUserId: null, action: "application.submit", entityType: "subcon_application", entityId: id, newValue: { companyName: input.companyName, plateNumber: input.plateNumber, trucks: 1 + input.extraTrucks.length } });
      await emitEvent(db, { type: "subcon.applied", tenantId: company.tenantId, applicationId: id });
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new HttpError(409, "This application was already received");
    throw err;
  }
  return { id, received: true as const };
}

// ---------------------------------------------------------------------------
// Staff: the list, the photos, the decision
// ---------------------------------------------------------------------------

function requireHauler(actor: TenantActor) {
  authorize(actor, "partner:read");
  if (actor.tenantKind !== "hauler") throw new HttpError(403, "Only a trucking company reviews applications");
}
const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function listApplications(actor: TenantActor, status?: "new" | "approved" | "rejected") {
  requireHauler(actor);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const rows = await db
      .select()
      .from(subconApplications)
      .where(status ? eq(subconApplications.status, status) : undefined)
      .orderBy(desc(subconApplications.createdAt));
    const extra = await db.select({ a: subconApplicationTrucks.applicationId, n: sql<number>`count(*)::int` }).from(subconApplicationTrucks).groupBy(subconApplicationTrucks.applicationId);
    const counts = new Map(extra.map((e) => [e.a, e.n]));
    return rows.map((a) => ({
      id: a.id,
      status: a.status,
      companyName: a.companyName,
      contactName: a.contactName,
      phone: a.phone,
      plateNumber: a.plateNumber,
      truckType: a.truckType,
      truckSize: a.truckSize,
      truckCount: 1 + (counts.get(a.id) ?? 0),
      createdAt: iso(a.createdAt),
    }));
  });
}

export async function getApplication(actor: TenantActor, id: string) {
  requireHauler(actor);
  return withTenant(actor.tenantId, actor.userId, async (db) => {
    const [a] = await db.select().from(subconApplications).where(eq(subconApplications.id, id));
    if (!a) throw new HttpError(404, "Application not found");
    const files = await db.select().from(subconApplicationFiles).where(eq(subconApplicationFiles.applicationId, id));
    const extras = await db.select().from(subconApplicationTrucks).where(eq(subconApplicationTrucks.applicationId, id)).orderBy(subconApplicationTrucks.createdAt, subconApplicationTrucks.plateNumber);
    const photosOf = (truckId: string | null) =>
      PHOTO_KINDS.map((kind) => {
        const f = files.find((x) => x.kind === kind && x.truckId === truckId);
        return { kind, label: photoLabel(kind), url: f ? storage.signedUrl(f.objectKey, 300) : null };
      });
    const [reviewer] = a.reviewedBy ? await db.select({ n: users.name }).from(users).where(eq(users.id, a.reviewedBy)) : [];
    return {
      id: a.id,
      status: a.status,
      companyName: a.companyName,
      contactName: a.contactName,
      phone: a.phone,
      email: a.email,
      address: a.address,
      plateNumber: a.plateNumber,
      truckType: a.truckType,
      truckSize: a.truckSize,
      capacityKg: a.capacityKg,
      driverName: a.driverName,
      licenseNumber: a.licenseNumber,
      licenseExpiry: a.licenseExpiry,
      notes: a.notes,
      createdAt: iso(a.createdAt),
      reviewedAt: iso(a.reviewedAt),
      reviewedBy: reviewer?.n ?? null,
      reviewNote: a.reviewNote,
      partnerTenantId: a.partnerTenantId,
      // Short-lived links, issued only after the permission check above.
      photos: photosOf(null),
      /** Every truck on the application, the first one included, each with its driver and photos. */
      trucks: [
        { plateNumber: a.plateNumber, truckType: a.truckType, truckSize: a.truckSize, capacityKg: a.capacityKg, driverName: a.driverName, licenseNumber: a.licenseNumber, licenseExpiry: a.licenseExpiry, photos: photosOf(null) },
        ...extras.map((t) => ({ plateNumber: t.plateNumber, truckType: t.truckType, truckSize: t.truckSize, capacityKg: t.capacityKg, driverName: t.driverName, licenseNumber: t.licenseNumber, licenseExpiry: t.licenseExpiry, photos: photosOf(t.id) })),
      ],
    };
  });
}

/**
 * Approve or reject. Approving, in ONE transaction: creates the subcontractor company, its owner login (with a
 * one-time starting password when the email is new), approves the partnership and puts the truck on its fleet.
 * The starting password is returned once so you can hand it over; it is never stored in readable form.
 */
export async function reviewApplication(actor: TenantActor, id: string, input: z.infer<typeof reviewApplicationInput>, ctx: Ctx = {}) {
  authorize(actor, "partner:manage");
  if (actor.tenantKind !== "hauler") throw new HttpError(403, "Only a trucking company reviews applications");
  if (input.decision === "reject" && !input.note) throw new HttpError(400, "Say why it was rejected");

  return withContext({ platform: true, userId: actor.userId }, async (db) => {
    const [a] = await db.select().from(subconApplications).where(and(eq(subconApplications.id, id), eq(subconApplications.tenantId, actor.tenantId))).for("update");
    if (!a) throw new HttpError(404, "Application not found");
    if (a.status !== "new") throw new HttpError(409, `This application was already ${a.status}`);
    const now = new Date();

    if (input.decision === "reject") {
      await db.update(subconApplications).set({ status: "rejected", reviewedBy: actor.userId, reviewedAt: now, reviewNote: input.note }).where(eq(subconApplications.id, id));
      await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "application.reject", entityType: "subcon_application", entityId: id, newValue: { note: input.note }, requestId: ctx.requestId });
      return { status: "rejected" as const };
    }

    const password = randomBytes(9).toString("base64url"); // 12 characters
    const company = await createSubcontractorCompany(db, { tenantId: actor.tenantId, actorUserId: actor.userId }, { companyName: a.companyName, ownerName: a.contactName, ownerEmail: a.email, password }, ctx.requestId);
    const extraTrucks = await db.select().from(subconApplicationTrucks).where(eq(subconApplicationTrucks.applicationId, id));
    await db.insert(trucks).values(
      [
        { plate: a.plateNumber, type: a.truckType, size: a.truckSize, cap: a.capacityKg },
        ...extraTrucks.map((t) => ({ plate: t.plateNumber, type: t.truckType, size: t.truckSize, cap: t.capacityKg })),
      ].map((t) => ({ tenantId: company.partnerTenantId, plate: t.plate, truckType: t.type.replace(/^Other: /, ""), bodySize: t.size.replace(/^Other: /, ""), capacityKg: t.cap ?? 1000 })),
    );
    await db.update(subconApplications).set({ status: "approved", reviewedBy: actor.userId, reviewedAt: now, reviewNote: input.note, partnerTenantId: company.partnerTenantId }).where(eq(subconApplications.id, id));
    await writeAudit(db, { tenantId: actor.tenantId, actorUserId: actor.userId, action: "application.approve", entityType: "subcon_application", entityId: id, newValue: { partnerTenantId: company.partnerTenantId }, requestId: ctx.requestId });
    return {
      status: "approved" as const,
      partnerTenantId: company.partnerTenantId,
      loginEmail: a.email,
      // Only for a brand-new login. An existing person keeps the password they already have.
      temporaryPassword: company.existingAccount ? null : password,
    };
  });
}
