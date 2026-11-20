import { sql } from "drizzle-orm";
import {
  bigint,
  doublePrecision,
  integer,
  bigserial,
  boolean,
  date,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const tenantKind = pgEnum("tenant_kind", ["hauler", "subcontractor"]);
export const tenantStatus = pgEnum("tenant_status", ["active", "suspended"]);
export const membershipRole = pgEnum("membership_role", [
  "owner",
  "ops_manager",
  "dispatcher",
  "accountant",
  "driver",
  "sub_owner",
  "sub_manager",
  "sub_driver",
  "client",
]);
export const membershipStatus = pgEnum("membership_status", ["active", "disabled"]);
export const partnerStatus = pgEnum("partner_status", ["pending", "approved", "revoked"]);
export const claimMode = pgEnum("claim_mode", ["immediate", "approval_required"]);

/** A company. Hauler companies own trips; subcontractor companies are separate tenants. */
export const tenants = pgTable("tenants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: tenantKind("kind").notNull().default("hauler"),
  status: tenantStatus("status").notNull().default("active"),
  timezone: text("timezone").notNull().default("Asia/Manila"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Global identity (not tenant-owned). A user may belong to several tenants. */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(t.email)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: membershipRole("role").notNull(),
    status: membershipStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memberships_tenant_user_uq").on(t.tenantId, t.userId)],
);

/** Server-side sessions. `id` is the SHA-256 of the cookie token; the raw token is never stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    activeTenantId: uuid("active_tenant_id").references(() => tenants.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** A hauler approves a subcontractor company as a partner. Subcontractors only ever see trips offered to them. */
export const partnerApprovals = pgTable(
  "partner_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    partnerTenantId: uuid("partner_tenant_id")
      .notNull()
      .references(() => tenants.id),
    status: partnerStatus("status").notNull().default("pending"),
    approvedBy: uuid("approved_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("partner_approvals_pair_uq").on(t.tenantId, t.partnerTenantId)],
);

export const companySettings = pgTable("company_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  claimMode: claimMode("claim_mode").notNull().default("approval_required"),
  podAutoApprove: boolean("pod_auto_approve").notNull().default(false),
  /** Drivers may attach a PDF receipt (for example a scanned delivery receipt). */
  allowPdfReceipts: boolean("allow_pdf_receipts").notNull().default(false),
  /** VAT rate in basis points added to invoices (1200 = 12%). 0 for companies that do not charge VAT. */
  vatBps: integer("vat_bps").notNull().default(0),
  /** Secret in the public link where truckers apply to become subcontractors (/apply/<token>). Null until first created. */
  applyToken: text("apply_token"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    name: text("name").notNull(),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    address: text("address"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customers_tenant_idx").on(t.tenantId)],
);

/** Append-only. UPDATE/DELETE are revoked from the app role and blocked by trigger. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    requestId: text("request_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_tenant_created_idx").on(t.tenantId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Phase 2: trips, dispatch, assignment, proof of delivery
// ---------------------------------------------------------------------------

export const tripStatus = pgEnum("trip_status", [
  "created",
  "offered",
  "assigned",
  "started",
  "arrived_pickup",
  "loaded",
  "in_transit",
  "arrived_destination",
  "pod_submitted",
  "delivery_exception",
  "ready_for_invoice",
  "cancelled",
]);
export const stopKind = pgEnum("stop_kind", ["pickup", "delivery"]);
/**
 * broadcast_*: private broadcast to an audience; selected: broadcast to chosen users (offer_targets);
 * direct: one driver (target_user_id) or one partner company (target_tenant_id);
 * applicants: open call where eligible people express interest and dispatch picks.
 */
export const offerMode = pgEnum("offer_mode", [
  "broadcast_internal",
  "direct",
  "broadcast_partners",
  "broadcast_all",
  "selected",
  "applicants",
]);
export const offerAudience = pgEnum("offer_audience", ["internal", "partners", "all"]);
export const truckStatus = pgEnum("truck_status", ["active", "maintenance", "retired"]);
export const applicationStatus = pgEnum("application_status", ["pending", "approved", "declined", "withdrawn", "expired"]);
export const offerStatus = pgEnum("offer_status", ["open", "accepted", "declined", "cancelled", "expired"]);
export const assignmentStatus = pgEnum("assignment_status", ["active", "released"]);
export const podOutcome = pgEnum("pod_outcome", ["complete", "partial", "discrepancy", "failed"]);
export const podStatus = pgEnum("pod_status", ["pending", "approved", "rejected", "more_info_requested"]);
export const gpsConsent = pgEnum("gps_consent", ["granted", "denied", "unavailable"]);
export const reviewDecision = pgEnum("review_decision", ["approve", "reject", "request_more"]);

export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    reference: text("reference").notNull(),
    status: tripStatus("status").notNull().default("created"),
    cargoDescription: text("cargo_description").notNull(),
    cargoType: text("cargo_type"),
    weightKg: integer("weight_kg"),
    quantity: integer("quantity"),
    truckRequirement: text("truck_requirement"),
    handlingInstructions: text("handling_instructions"),
    notes: text("notes"),
    /** What the customer pays. NEVER serialized to drivers or subcontractors, nor logged. */
    contractRateCentavos: bigint("contract_rate_centavos", { mode: "number" }).notNull(),
    /** What the assigned operator is offered. */
    payoutCentavos: bigint("payout_centavos", { mode: "number" }).notNull(),
  /** What a subcontractor is paid for this trip, when it differs from the own-driver pay above. Null = same as payoutCentavos. */
  subcontractorPayoutCentavos: bigint("subcontractor_payout_centavos", { mode: "number" }),
  /** What the company pays a helper (pahinante) for this trip on its own trucks. A cost of own-truck trips only. */
  helperPayCentavos: bigint("helper_pay_centavos", { mode: "number" }).notNull().default(0),
    fuelIncluded: boolean("fuel_included").notNull().default(false),
    tollIncluded: boolean("toll_included").notNull().default(false),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trips_tenant_reference_uq").on(t.tenantId, t.reference),
    index("trips_tenant_status_idx").on(t.tenantId, t.status),
  ],
);

export const tripStops = pgTable(
  "trip_stops",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    seq: integer("seq").notNull(),
    kind: stopKind("kind").notNull(),
    address: text("address").notNull(),
    requiredArrivalAt: timestamp("required_arrival_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("trip_stops_trip_seq_uq").on(t.tripId, t.seq)],
);

/** One slot per truck a trip needs. Phase 2 UI creates a single slot; the model supports several. */
export const tripSlots = pgTable(
  "trip_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    slotNo: integer("slot_no").notNull(),
  },
  (t) => [uniqueIndex("trip_slots_trip_no_uq").on(t.tripId, t.slotNo)],
);

export const tripOffers = pgTable(
  "trip_offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => tripSlots.id),
    mode: offerMode("mode").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id),
    /** Direct offer to a partner company. */
    targetTenantId: uuid("target_tenant_id").references(() => tenants.id),
    /** Who may apply, for `applicants` offers. */
    audience: offerAudience("audience"),
    status: offerStatus("status").notNull().default("open"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    respondedAt: timestamp("responded_at", { withTimezone: true }),
  },
  (t) => [index("trip_offers_trip_idx").on(t.tripId), index("trip_offers_target_idx").on(t.targetUserId)],
);

/** A slot can have at most ONE active assignment: enforced by the partial unique index below. */
export const tripAssignments = pgTable(
  "trip_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => tripSlots.id),
    driverUserId: uuid("driver_user_id")
      .notNull()
      .references(() => users.id),
    offerId: uuid("offer_id").references(() => tripOffers.id),
    status: assignmentStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Company doing the work: the hauler itself for internal drivers, or a partner company. */
    assignedTenantId: uuid("assigned_tenant_id")
      .notNull()
      .references(() => tenants.id),
    truckId: uuid("truck_id"),
    /** Snapshots, because a partner's truck and driver rows are not readable from the hauler's tenant. */
    truckPlate: text("truck_plate"),
    driverName: text("driver_name"),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releasedBy: uuid("released_by").references(() => users.id),
    releasedReason: text("released_reason"),
  },
  (t) => [
    uniqueIndex("trip_assignments_one_active_per_slot")
      .on(t.slotId)
      .where(sql`${t.status} = 'active'`),
    index("trip_assignments_driver_idx").on(t.driverUserId),
  ],
);

/** Append-only history of every trip state transition. */
export const tripStatusEvents = pgTable(
  "trip_status_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    fromStatus: tripStatus("from_status"),
    toStatus: tripStatus("to_status").notNull(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trip_status_events_trip_idx").on(t.tripId)],
);

/**
 * Proof-of-delivery versions. Rows are evidence: never deleted, and only `status` may change
 * (column-level grant). Timestamps are kept separate on purpose:
 *  - actual_delivery_at: what the driver says; source/verification recorded beside it
 *  - uploaded_at: server clock at receipt
 */
export const epodSubmissions = pgTable(
  "epod_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    stopId: uuid("stop_id").references(() => tripStops.id),
    version: integer("version").notNull(),
    status: podStatus("status").notNull().default("pending"),
    outcome: podOutcome("outcome").notNull(),
    receiverName: text("receiver_name").notNull(),
    deliveredQuantity: integer("delivered_quantity"),
    discrepancyNotes: text("discrepancy_notes"),
    comments: text("comments"),
    actualDeliveryAt: timestamp("actual_delivery_at", { withTimezone: true }).notNull(),
    actualDeliverySource: text("actual_delivery_source").notNull().default("driver_entered"),
    deliveryVerification: text("delivery_verification").notNull().default("unverified"),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    /** Set when someone submits for the assigned driver (proxy submission). */
    onBehalfOfUserId: uuid("on_behalf_of_user_id").references(() => users.id),
    driverUserId: uuid("driver_user_id")
      .notNull()
      .references(() => users.id),
    gpsConsent: gpsConsent("gps_consent").notNull().default("unavailable"),
    gpsLat: doublePrecision("gps_lat"),
    gpsLng: doublePrecision("gps_lng"),
    gpsAccuracyM: doublePrecision("gps_accuracy_m"),
    idempotencyKey: text("idempotency_key").notNull(),
    /** True when the phone queued this while offline and it was uploaded later. */
    submittedOffline: boolean("submitted_offline").notNull().default(false),
    /** When the phone says it queued the submission. Device clock: reported, never verified. */
    deviceQueuedAt: timestamp("device_queued_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("epod_stop_version_uq").on(t.stopId, t.version),
    index("epod_trip_idx").on(t.tripId),
    uniqueIndex("epod_idempotency_uq").on(t.tenantId, t.idempotencyKey),
  ],
);

export const epodAttachments = pgTable(
  "epod_attachments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => epodSubmissions.id),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    /** Device-reported capture time, only when supplied. Never inferred; null if unknown. */
    capturedAt: timestamp("captured_at", { withTimezone: true }),
    /** Where captured_at came from. Only "device_exif" exists: read from the image metadata, never inferred. */
    capturedSource: text("captured_source"),
    /** photo | signature | pdf */
    kind: text("kind").notNull().default("photo"),
    uploadStatus: text("upload_status").notNull().default("stored"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("epod_attachments_submission_idx").on(t.submissionId)],
);

export const podReviews = pgTable(
  "pod_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => epodSubmissions.id),
    /** Null for an automatic approval by company policy. */
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id),
    automatic: boolean("automatic").notNull().default(false),
    decision: reviewDecision("decision").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pod_reviews_submission_idx").on(t.submissionId)],
);

// ---------------------------------------------------------------------------
// Phase 3: fleet, driver qualifications, offers to many audiences, applications
// ---------------------------------------------------------------------------

export const trucks = pgTable(
  "trucks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    plate: text("plate").notNull(),
    truckType: text("truck_type").notNull(),
    capacityKg: integer("capacity_kg").notNull(),
    /** Body length as people quote it when booking a truck, for example 14ft. Optional. */
    bodySize: text("body_size"),
    registrationExpiry: date("registration_expiry", { mode: "string" }),
    inspectionExpiry: date("inspection_expiry", { mode: "string" }),
    status: truckStatus("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("trucks_tenant_plate_uq").on(t.tenantId, t.plate)],
);

export const driverProfiles = pgTable(
  "driver_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    licenseNumber: text("license_number"),
    licenseExpiry: date("license_expiry", { mode: "string" }),
    phone: text("phone"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("driver_profiles_tenant_user_uq").on(t.tenantId, t.userId)],
);

/** Recipients of a `selected` broadcast. */
export const tripOfferTargets = pgTable(
  "trip_offer_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => tripOffers.id),
    targetUserId: uuid("target_user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [uniqueIndex("trip_offer_targets_uq").on(t.offerId, t.targetUserId)],
);

/**
 * A request to take a slot. Created when acceptance needs dispatch approval (company setting) or the
 * offer is an `applicants` call. Approving one creates the assignment.
 */
export const tripApplications = pgTable(
  "trip_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    slotId: uuid("slot_id")
      .notNull()
      .references(() => tripSlots.id),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => tripOffers.id),
    applicantUserId: uuid("applicant_user_id")
      .notNull()
      .references(() => users.id),
    applicantTenantId: uuid("applicant_tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** The truck and driver that will do the job (a partner picks both; an internal driver is their own driver). */
    truckId: uuid("truck_id"),
    driverUserId: uuid("driver_user_id")
      .notNull()
      .references(() => users.id),
    truckPlate: text("truck_plate"),
    driverName: text("driver_name"),
    status: applicationStatus("status").notNull().default("pending"),
    decidedBy: uuid("decided_by").references(() => users.id),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("trip_applications_one_pending")
      .on(t.slotId, t.applicantUserId)
      .where(sql`${t.status} = 'pending'`),
    index("trip_applications_trip_idx").on(t.tripId),
  ],
);

// ---------------------------------------------------------------------------
// Phase 4: file processing state and background jobs
// ---------------------------------------------------------------------------

/** Mutable processing state for an (immutable) attachment: malware scan and compressed display copy. */
export const epodAttachmentProcessing = pgTable("epod_attachment_processing", {
  attachmentId: uuid("attachment_id")
    .primaryKey()
    .references(() => epodAttachments.id),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenants.id),
  scanStatus: text("scan_status").notNull().default("pending"), // pending | clean | infected | error
  scanDetail: text("scan_detail"),
  scannedAt: timestamp("scanned_at", { withTimezone: true }),
  displayStatus: text("display_status").notNull().default("pending"), // pending | ready | skipped | failed
  displayKey: text("display_key"),
  displayBytes: integer("display_bytes"),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Database-backed job queue: retries with backoff, and a unique dedupe key so a job is never enqueued twice. */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    status: text("status").notNull().default("queued"), // queued | running | done | failed
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("jobs_dedupe_uq").on(t.dedupeKey), index("jobs_due_idx").on(t.status, t.runAt)],
);

// ---------------------------------------------------------------------------
// Phase 5: finance (invoices, settlements, expenses). All money is integer centavos.
// ---------------------------------------------------------------------------

export const invoiceStatus = pgEnum("invoice_status", ["issued", "paid", "void"]);
export const expenseCategory = pgEnum("expense_category", ["fuel", "toll", "parking", "loading", "repair", "other"]);
export const expenseStatus = pgEnum("expense_status", ["submitted", "approved", "rejected"]);

/** Gap-free sequence per company, kind and year (INV-2026-0001, SET-2026-0001). */
export const documentCounters = pgTable(
  "document_counters",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    kind: text("kind").notNull(),
    year: integer("year").notNull(),
    lastSeq: integer("last_seq").notNull().default(0),
  },
  (t) => [uniqueIndex("document_counters_pk").on(t.tenantId, t.kind, t.year)],
);

/**
 * A bill to a customer. Amounts are fixed at issue time: only status, payment and void fields can change
 * afterwards (column grant + trigger). One active invoice line per trip means a trip cannot be billed twice.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: text("number").notNull(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    status: invoiceStatus("status").notNull().default("issued"),
    /** Client-supplied key: repeating the same request returns the same invoice. */
    idempotencyKey: text("idempotency_key").notNull(),
    subtotalCentavos: bigint("subtotal_centavos", { mode: "number" }).notNull(),
    vatBps: integer("vat_bps").notNull().default(0),
    vatCentavos: bigint("vat_centavos", { mode: "number" }).notNull().default(0),
    totalCentavos: bigint("total_centavos", { mode: "number" }).notNull(),
    paymentTermsDays: integer("payment_terms_days").notNull().default(30),
    notes: text("notes"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentReference: text("payment_reference"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("invoices_tenant_number_uq").on(t.tenantId, t.number),
    uniqueIndex("invoices_tenant_idem_uq").on(t.tenantId, t.idempotencyKey),
    index("invoices_customer_idx").on(t.customerId),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    description: text("description").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    /** False once the invoice is voided, which frees the trip to be billed again. */
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("invoice_lines_one_active_per_trip")
      .on(t.tripId)
      .where(sql`${t.active}`),
    index("invoice_lines_invoice_idx").on(t.invoiceId),
  ],
);

/** What the hauler owes a subcontractor company for completed trips, from the payout agreed on each trip. */
export const settlements = pgTable(
  "settlements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    number: text("number").notNull(),
    partnerTenantId: uuid("partner_tenant_id")
      .notNull()
      .references(() => tenants.id),
    status: invoiceStatus("status").notNull().default("issued"),
    idempotencyKey: text("idempotency_key").notNull(),
    totalCentavos: bigint("total_centavos", { mode: "number" }).notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull().defaultNow(),
    createdBy: uuid("created_by").references(() => users.id),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    paymentReference: text("payment_reference"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("settlements_tenant_number_uq").on(t.tenantId, t.number),
    uniqueIndex("settlements_tenant_idem_uq").on(t.tenantId, t.idempotencyKey),
    index("settlements_partner_idx").on(t.partnerTenantId),
  ],
);

export const settlementLines = pgTable(
  "settlement_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    settlementId: uuid("settlement_id")
      .notNull()
      .references(() => settlements.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    description: text("description").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("settlement_lines_one_active_per_trip")
      .on(t.tripId)
      .where(sql`${t.active}`),
    index("settlement_lines_settlement_idx").on(t.settlementId),
  ],
);

/**
 * A cost tied to one trip (fuel, toll, ...). Drivers submit theirs with a receipt; staff can add company-paid
 * ones. It only counts against trip profit once approved AND marked as borne by the company.
 */
export const tripExpenses = pgTable(
  "trip_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    category: expenseCategory("category").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    incurredAt: timestamp("incurred_at", { withTimezone: true }).notNull(),
    note: text("note"),
    status: expenseStatus("status").notNull().default("submitted"),
    /** Who carries the cost. Decided at approval; staff-entered company expenses start as company-borne. */
    companyBears: boolean("company_bears").notNull().default(false),
    submittedBy: uuid("submitted_by")
      .notNull()
      .references(() => users.id),
    /** Driver who paid and may need reimbursing; null for company-paid items. */
    paidByDriverId: uuid("paid_by_driver_id").references(() => users.id),
    receiptKey: text("receipt_key"),
    receiptMime: text("receipt_mime"),
    receiptSha256: text("receipt_sha256"),
    receiptBytes: integer("receipt_bytes"),
    idempotencyKey: text("idempotency_key").notNull(),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trip_expenses_trip_idx").on(t.tripId), uniqueIndex("trip_expenses_idem_uq").on(t.tenantId, t.idempotencyKey)],
);

// ---------------------------------------------------------------------------
// Phase 6: notifications
// ---------------------------------------------------------------------------

/**
 * One in-app notification for one person. tenant_id is the RECIPIENT's company, so the person reads it in their own
 * context (a subcontractor's driver reads theirs in the subcontractor's tenant even when the trip is the hauler's).
 * (user_id, dedupe_key) is unique: processing the same event twice can never notify the same person twice.
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** In-app path to open, already correct for the recipient's role. */
    link: text("link"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("notifications_user_dedupe_uq").on(t.userId, t.dedupeKey),
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
  ],
);

/** Delivery attempts per channel (push, sms). Written only by the background worker. */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notifications.id),
    channel: text("channel").notNull(), // push | sms
    status: text("status").notNull(), // sent | none | skipped | failed
    detail: text("detail"),
    attempts: integer("attempts").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("notification_deliveries_uq").on(t.notificationId, t.channel)],
);

/** A browser/device a person allowed to receive Web Push on. Owned by the person, not by a company. */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("push_subscriptions_endpoint_uq").on(t.endpoint), index("push_subscriptions_user_idx").on(t.userId)],
);

/** A person's own contact and channel choices. SMS is opt-in and only used as a fallback for urgent items. */
export const userNotificationSettings = pgTable("user_notification_settings", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  /** Philippine mobile number in E.164 form (+639XXXXXXXXX). */
  phone: text("phone"),
  smsEnabled: boolean("sms_enabled").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// Company cost ledger: diesel, RFID, maintenance, salaries and the rest of what the business spends.
// (Costs a driver reports on one trip live in trip_expenses and go through review; this is the owner's own ledger.)
// ---------------------------------------------------------------------------

export const companyExpenses = pgTable(
  "company_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    /** One of COST_CATEGORIES (src/shared/costs.ts). */
    category: text("category").notNull(),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    incurredOn: date("incurred_on", { mode: "string" }).notNull(),
    note: text("note"),
    /** Who was paid: a fuel station, a shop, an employee. */
    payee: text("payee"),
    /** Optional links. A cost linked to a trip counts in that trip's profit; one linked to a truck shows in that truck's costs. */
    truckId: uuid("truck_id").references(() => trucks.id),
    tripId: uuid("trip_id").references(() => trips.id),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("company_expenses_tenant_date_idx").on(t.tenantId, t.incurredOn),
    uniqueIndex("company_expenses_idem_uq").on(t.tenantId, t.idempotencyKey),
  ],
);

// ---------------------------------------------------------------------------
// Subcontractor applications: truckers apply online, staff review the photos and approve or reject.
// ---------------------------------------------------------------------------

export const applicationStatus2 = pgEnum("subcon_application_status", ["new", "approved", "rejected"]);

export const subconApplications = pgTable(
  "subcon_applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    status: applicationStatus2("status").notNull().default("new"),
    companyName: text("company_name").notNull(),
    contactName: text("contact_name").notNull(),
    phone: text("phone").notNull(),
    email: text("email").notNull(),
    address: text("address"),
    plateNumber: text("plate_number").notNull(),
    truckType: text("truck_type").notNull(),
    truckSize: text("truck_size").notNull(),
    capacityKg: integer("capacity_kg"),
    driverName: text("driver_name").notNull(),
    licenseNumber: text("license_number"),
    licenseExpiry: date("license_expiry", { mode: "string" }),
    notes: text("notes"),
    submittedFromIp: text("submitted_from_ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
    /** The subcontractor company created when the application was approved. */
    partnerTenantId: uuid("partner_tenant_id").references(() => tenants.id),
  },
  (t) => [index("subcon_applications_tenant_status_idx").on(t.tenantId, t.status), index("subcon_applications_plate_idx").on(t.tenantId, t.plateNumber)],
);

/** Further trucks on the same application (an owner with several units). The first truck lives on the application row itself. */
export const subconApplicationTrucks = pgTable(
  "subcon_application_trucks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => subconApplications.id),
    plateNumber: text("plate_number").notNull(),
    truckType: text("truck_type").notNull(),
    truckSize: text("truck_size").notNull(),
    capacityKg: integer("capacity_kg"),
    driverName: text("driver_name").notNull(),
    licenseNumber: text("license_number"),
    licenseExpiry: date("license_expiry", { mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subcon_application_trucks_plate_uq").on(t.applicationId, t.plateNumber)],
);

/** One photo per required angle: left, right, front, back, plate, and the driver's license. */
export const subconApplicationFiles = pgTable(
  "subcon_application_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => subconApplications.id),
    /** Null = the application's first truck; otherwise one of its further trucks. */
    truckId: uuid("truck_id").references(() => subconApplicationTrucks.id),
    kind: text("kind").notNull(),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    scanStatus: text("scan_status").notNull().default("clean"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("subcon_application_files_kind_uq").on(t.applicationId, sql`coalesce(${t.truckId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.kind)],
);

/** Failed sign-ins, kept as hashes (never the email or address itself) so repeated guessing can be slowed down. */
export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    emailHash: text("email_hash").notNull(),
    ipHash: text("ip_hash").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_email_idx").on(t.emailHash, t.at), index("login_attempts_ip_idx").on(t.ipHash, t.at)],
);

// ---------------------------------------------------------------------------
// Phase 7: plans, subscriptions and manual subscription payments (platform-managed)
// ---------------------------------------------------------------------------

export const subscriptionStatus = pgEnum("subscription_status", ["trialing", "active", "expired", "cancelled"]);

/** What a company can buy. Null limits mean unlimited. Feature flags are keys of PLAN_FEATURES (src/shared/plans.ts). */
export const subscriptionPlans = pgTable("subscription_plans", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description"),
  priceCentavos: bigint("price_centavos", { mode: "number" }).notNull(),
  /** Months one paid period lasts: 1 monthly, 12 yearly. */
  periodMonths: integer("period_months").notNull().default(1),
  maxTrucks: integer("max_trucks"),
  maxDrivers: integer("max_drivers"),
  maxUsers: integer("max_users"),
  features: jsonb("features").$type<Record<string, boolean>>().notNull().default({}),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One subscription per company. A company with no row is a legacy or internal company and is not limited. */
export const subscriptions = pgTable("subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .unique()
    .references(() => tenants.id),
  planId: uuid("plan_id")
    .notNull()
    .references(() => subscriptionPlans.id),
  status: subscriptionStatus("status").notNull().default("trialing"),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull().defaultNow(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  notes: text("notes"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Money the company paid for its subscription, recorded by hand by the platform admin. Never edited or deleted. */
export const subscriptionPayments = pgTable(
  "subscription_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => subscriptions.id),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    paidOn: date("paid_on", { mode: "string" }).notNull(),
    method: text("method"),
    reference: text("reference"),
    periodsAdded: integer("periods_added").notNull().default(1),
    recordedBy: uuid("recorded_by")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("subscription_payments_tenant_idx").on(t.tenantId, t.paidOn)],
);

// ---------------------------------------------------------------------------
// Per-client documents needed after a trip (customised by the company owner)
// ---------------------------------------------------------------------------

export const documentUploader = pgEnum("document_uploader", ["driver", "dispatcher", "either"]);

/** What one client wants on file for every trip, e.g. signed delivery receipt, weighing ticket, gate pass. */
export const customerDocumentTypes = pgTable(
  "customer_document_types",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    name: text("name").notNull(),
    instructions: text("instructions"),
    required: boolean("required").notNull().default(true),
    uploader: documentUploader("uploader").notNull().default("either"),
    position: integer("position").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("customer_document_types_customer_idx").on(t.tenantId, t.customerId)],
);

/**
 * The checklist of one trip, copied from the client's list when the trip is created. Dispatch can add or remove
 * items for a single trip; later edits to the client's list never rewrite trips already booked.
 */
export const tripDocuments = pgTable(
  "trip_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    tripId: uuid("trip_id")
      .notNull()
      .references(() => trips.id),
    sourceTypeId: uuid("source_type_id").references(() => customerDocumentTypes.id),
    name: text("name").notNull(),
    instructions: text("instructions"),
    required: boolean("required").notNull().default(true),
    uploader: documentUploader("uploader").notNull().default("either"),
    position: integer("position").notNull().default(0),
    /** A required item the client waived for this trip. The reason is kept. */
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waivedBy: uuid("waived_by").references(() => users.id),
    waiveReason: text("waive_reason"),
    /** Taken off this trip's list. Kept so history stays whole. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("trip_documents_trip_idx").on(t.tenantId, t.tripId)],
);

/** Every upload is a new version; nothing is overwritten. Only the review fields change. */
export const tripDocumentFiles = pgTable(
  "trip_document_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    documentId: uuid("document_id")
      .notNull()
      .references(() => tripDocuments.id),
    version: integer("version").notNull(),
    objectKey: text("object_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    uploadedBy: uuid("uploaded_by")
      .notNull()
      .references(() => users.id),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull().default("pending"),
    reviewedBy: uuid("reviewed_by").references(() => users.id),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    reviewNote: text("review_note"),
  },
  (t) => [uniqueIndex("trip_document_files_version_uq").on(t.documentId, t.version)],
);

// ---------------------------------------------------------------------------
// Money received from clients, recorded by hand (payments, weekly remittances...). Separate from trip invoices.
// ---------------------------------------------------------------------------

export const companyIncome = pgTable(
  "company_income",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    amountCentavos: bigint("amount_centavos", { mode: "number" }).notNull(),
    receivedOn: date("received_on", { mode: "string" }).notNull(),
    note: text("note"),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id),
    idempotencyKey: text("idempotency_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidedBy: uuid("voided_by").references(() => users.id),
    voidReason: text("void_reason"),
  },
  (t) => [index("company_income_tenant_date_idx").on(t.tenantId, t.receivedOn), uniqueIndex("company_income_idem_uq").on(t.tenantId, t.idempotencyKey)],
);
