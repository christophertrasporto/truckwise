const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" });

/** Money is stored as integer centavos; only formatting converts to pesos. */
export const formatPeso = (centavos: number) => peso.format(centavos / 100);

/** "1,234.50" or "1234.5" -> 123450. Returns null for anything that is not a valid non-negative amount. */
export function pesosToCentavos(input: string): number | null {
  const cleaned = input.replace(/[,\s₱]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

const TZ = "Asia/Manila"; // becomes a per-company setting later

export const formatDateTime = (iso: string | Date | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("en-PH", { timeZone: TZ, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
    : "-";
