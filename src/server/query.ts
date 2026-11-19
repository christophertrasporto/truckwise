import { pesosToCentavos } from "@/shared/format";
import { boardFilters, type BoardFilters } from "@/shared/schemas/trip";

/** Query string to an object, dropping empty values so optional zod fields stay optional. */
export function queryObject(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URL(req.url).searchParams) if (v !== "") out[k] = v;
  return out;
}

/** Board filters from a page's searchParams. Bad values are ignored rather than shown as errors. */
export function boardQuery(sp: Record<string, string | string[] | undefined>): BoardFilters {
  const pick = (k: string) => {
    const v = sp[k];
    const s = Array.isArray(v) ? v[0] : v;
    return s && s.trim() !== "" ? s.trim() : undefined;
  };
  const min = pick("minPayout");
  const parsed = boardFilters.safeParse({
    location: pick("location"),
    from: pick("from"),
    to: pick("to"),
    truckType: pick("truckType"),
    minPayoutCentavos: min ? (pesosToCentavos(min) ?? undefined) : undefined,
  });
  return parsed.success ? parsed.data : {};
}
