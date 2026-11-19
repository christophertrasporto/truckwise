import { sql } from "drizzle-orm";
import type { Db } from "../../db";
import { documentCounters } from "../../db/schema";

/**
 * Next gap-free document number for this company, e.g. INV-2026-0001. The counter row is locked by the upsert,
 * so concurrent generators queue behind each other, and a rolled-back transaction gives its number back.
 */
export async function nextDocumentNumber(db: Db, tenantId: string, kind: "invoice" | "settlement"): Promise<string> {
  const year = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4)); // Asia/Manila calendar year
  const [row] = await db
    .insert(documentCounters)
    .values({ tenantId, kind, year, lastSeq: 1 })
    .onConflictDoUpdate({ target: [documentCounters.tenantId, documentCounters.kind, documentCounters.year], set: { lastSeq: sql`${documentCounters.lastSeq} + 1` } })
    .returning({ seq: documentCounters.lastSeq });
  return `${kind === "invoice" ? "INV" : "SET"}-${year}-${String(row.seq).padStart(4, "0")}`;
}

export const centavosToPesoString = (c: number) =>
  `${c < 0 ? "-" : ""}PHP ${(Math.abs(c) / 100).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
