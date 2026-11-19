import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import sharp from "sharp";
import { formatDateTime } from "@/shared/format";
import { storage } from "../../storage";
import type { TenantActor } from "../trips";
import { centavosToPesoString } from "./shared";
import { getInvoice } from "./invoices";

type InvoiceView = Awaited<ReturnType<typeof getInvoice>>;

const A4: [number, number] = [595.28, 841.89];
const M = 48;

/** The standard PDF fonts only cover Latin-1; anything else becomes "?" rather than failing the whole document. */
const clean = (s: string) => s.replace(/[^\x20-\x7e\xa0-\xff]/g, "?");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of clean(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > width && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** An invoice PDF: the bill on page 1, then the approved proof of delivery (receiver, times, photos, signature) of every trip billed. */
export async function buildInvoicePdf(inv: InvoiceView): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${inv.number} - ${inv.customerName}`);
  pdf.setProducer("Truckwise");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.09, 0.14);
  const grey = rgb(0.4, 0.44, 0.52);

  let page: PDFPage = pdf.addPage(A4);
  let y = A4[1] - M;
  const ensure = (need: number) => {
    if (y - need < M) {
      page = pdf.addPage(A4);
      y = A4[1] - M;
    }
  };
  const text = (s: string, o: { x?: number; size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; right?: number } = {}) => {
    const size = o.size ?? 10;
    const f = o.f ?? font;
    const t = clean(s);
    const x = o.right !== undefined ? o.right - f.widthOfTextAtSize(t, size) : (o.x ?? M);
    page.drawText(t, { x, y, size, font: f, color: o.color ?? ink });
  };
  const para = (s: string, o: { x?: number; size?: number; f?: PDFFont; width?: number; color?: ReturnType<typeof rgb> } = {}) => {
    const size = o.size ?? 10;
    for (const l of wrap(s, o.f ?? font, size, o.width ?? A4[0] - 2 * M)) {
      ensure(size + 4);
      text(l, { ...o, size });
      y -= size + 4;
    }
  };

  // --- page 1: the bill ---
  text(inv.company, { size: 18, f: bold });
  text("INVOICE", { size: 18, f: bold, right: A4[0] - M });
  y -= 24;
  text(`Invoice no. ${inv.number}`, { size: 11, f: bold });
  text(`Status: ${inv.status.toUpperCase()}`, { right: A4[0] - M, f: bold, color: inv.status === "void" ? rgb(0.8, 0.2, 0.2) : ink });
  y -= 16;
  text(`Issued ${formatDateTime(inv.issuedAt)}`, { color: grey });
  y -= 14;
  text(`Payment due ${formatDateTime(inv.dueAt)} (${inv.paymentTermsDays} days)`, { color: grey });
  y -= 26;
  text("Bill to", { size: 9, color: grey });
  y -= 14;
  text(inv.customerName, { size: 12, f: bold });
  y -= 14;
  if (inv.customerAddress) para(inv.customerAddress);
  y -= 14;

  page.drawLine({ start: { x: M, y: y + 6 }, end: { x: A4[0] - M, y: y + 6 }, thickness: 0.8, color: grey });
  text("Description", { size: 9, f: bold, color: grey });
  text("Amount", { size: 9, f: bold, color: grey, right: A4[0] - M });
  y -= 16;
  for (const l of inv.lines) {
    const lines = wrap(l.description, font, 10, A4[0] - 2 * M - 110);
    ensure(lines.length * 14 + 6);
    text(centavosToPesoString(l.amountCentavos), { right: A4[0] - M });
    for (const t of lines) {
      text(t);
      y -= 14;
    }
    y -= 4;
  }
  y -= 6;
  page.drawLine({ start: { x: M, y: y + 8 }, end: { x: A4[0] - M, y: y + 8 }, thickness: 0.8, color: grey });
  ensure(80);
  const row = (label: string, value: string, strong = false) => {
    text(label, { x: A4[0] - M - 230, f: strong ? bold : font });
    text(value, { right: A4[0] - M, f: strong ? bold : font });
    y -= 16;
  };
  row("Subtotal", centavosToPesoString(inv.subtotalCentavos));
  row(`VAT (${(inv.vatBps / 100).toFixed(inv.vatBps % 100 ? 2 : 0)}%)`, centavosToPesoString(inv.vatCentavos));
  row("Total due", centavosToPesoString(inv.totalCentavos), true);
  if (inv.status === "paid") {
    y -= 6;
    text(`Paid ${formatDateTime(inv.paidAt)}. Reference: ${inv.paymentReference ?? "-"}`, { color: grey });
    y -= 14;
  }
  if (inv.status === "void") {
    y -= 6;
    para(`VOID: ${inv.voidReason ?? ""}`, { color: rgb(0.8, 0.2, 0.2), f: bold });
  }
  if (inv.notes) {
    y -= 8;
    para(inv.notes, { color: grey });
  }
  y -= 10;
  para("Approved proof of delivery for each trip follows.", { color: grey, size: 9 });

  // --- proof pages ---
  const embed = async (key: string, kind: "photo" | "signature") => {
    const bytes = await storage.get(key);
    if (kind === "signature") return pdf.embedPng(bytes);
    const jpeg = await sharp(bytes, { failOn: "none" }).rotate().resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 75 }).toBuffer();
    return pdf.embedJpg(jpeg);
  };
  for (const line of inv.lines) {
    page = pdf.addPage(A4);
    y = A4[1] - M;
    text(`Proof of delivery: ${line.reference}`, { size: 14, f: bold });
    y -= 20;
    if (line.proof.length === 0) para("No approved proof is on file for this trip.", { color: grey });
    for (const p of line.proof) {
      ensure(120);
      para(`${p.stopSeq ? `Stop ${p.stopSeq}: ` : ""}${p.stopAddress ?? "Delivery"}`, { f: bold, size: 11 });
      para(`Received by ${p.receiverName}. Delivery time confirmed by the driver: ${formatDateTime(p.deliveredAt)}. Received by our system: ${formatDateTime(p.uploadedAt)}.`, { size: 9, color: grey });
      para(`Approved ${formatDateTime(p.approvedAt)} by ${p.approvedBy ?? "-"}.`, { size: 9, color: grey });
      y -= 4;
      const images: { key: string; kind: "photo" | "signature" }[] = [
        ...p.photos.slice(0, 6).map((f) => ({ key: f.displayKey ?? f.objectKey, kind: "photo" as const })),
        ...(p.signature ? [{ key: p.signature.objectKey, kind: "signature" as const }] : []),
      ];
      const cell = (A4[0] - 2 * M - 12) / 2;
      for (let i = 0; i < images.length; i += 2) {
        const pair = images.slice(i, i + 2);
        const embedded = await Promise.all(pair.map((im) => embed(im.key, im.kind).catch(() => null)));
        const h = Math.min(170, ...embedded.map((e) => (e ? (e.height * cell) / e.width : 170)));
        ensure(h + 14);
        embedded.forEach((e, j) => {
          if (!e) return;
          const w = Math.min(cell, (e.width * h) / e.height);
          page.drawImage(e, { x: M + j * (cell + 12), y: y - h, width: w, height: h });
        });
        y -= h + 12;
      }
      for (const f of p.pdfs) para(`PDF receipt on file: ${f.filename}`, { size: 9, color: grey });
      y -= 10;
    }
  }
  return pdf.save();
}

export async function invoicePdf(actor: TenantActor, id: string): Promise<{ filename: string; data: Uint8Array }> {
  const inv = await getInvoice(actor, id); // authorizes finance:read and scopes to the company
  return { filename: `${inv.number}.pdf`, data: await buildInvoicePdf(inv) };
}
