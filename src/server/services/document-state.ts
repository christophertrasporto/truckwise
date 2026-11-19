import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import type { Db } from "../db";
import { tripDocumentFiles, tripDocuments } from "../db/schema";

export type DocState = "missing" | "pending" | "approved" | "rejected" | "waived";

export interface ChecklistItem {
  id: string;
  name: string;
  instructions: string | null;
  required: boolean;
  uploader: "driver" | "dispatcher" | "either";
  state: DocState;
  waiveReason: string | null;
  latest: { id: string; version: number; filename: string; mime: string; status: string; reviewNote: string | null; uploadedAt: Date; objectKey: string } | null;
  versions: number;
}

/** Where every item of a trip's checklist stands, from its newest upload. Removed items are left out. */
export async function checklist(db: Db, tripId: string): Promise<ChecklistItem[]> {
  const docs = await db
    .select()
    .from(tripDocuments)
    .where(and(eq(tripDocuments.tripId, tripId), isNull(tripDocuments.removedAt)))
    .orderBy(asc(tripDocuments.position), asc(tripDocuments.createdAt));
  if (docs.length === 0) return [];
  const files = await db
    .select()
    .from(tripDocumentFiles)
    .where(inArray(tripDocumentFiles.documentId, docs.map((d) => d.id)))
    .orderBy(desc(tripDocumentFiles.version));
  return docs.map((d) => {
    const mine = files.filter((f) => f.documentId === d.id); // newest first
    const latest = mine[0] ?? null;
    const state: DocState = d.waivedAt ? "waived" : !latest ? "missing" : latest.status === "approved" ? "approved" : latest.status === "rejected" ? "rejected" : "pending";
    return {
      id: d.id,
      name: d.name,
      instructions: d.instructions,
      required: d.required,
      uploader: d.uploader,
      state,
      waiveReason: d.waiveReason,
      latest: latest
        ? { id: latest.id, version: latest.version, filename: latest.originalFilename, mime: latest.mimeType, status: latest.status, reviewNote: latest.reviewNote, uploadedAt: latest.uploadedAt, objectKey: latest.objectKey }
        : null,
      versions: mine.length,
    };
  });
}

/** Required items that are neither approved nor waived. A trip cannot be billed while any remain. */
export async function outstandingDocuments(db: Db, tripId: string): Promise<string[]> {
  return (await checklist(db, tripId)).filter((i) => i.required && i.state !== "approved" && i.state !== "waived").map((i) => i.name);
}
