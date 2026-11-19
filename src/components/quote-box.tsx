"use client";

import { quote } from "@/shared/costs";
import { formatPeso, pesosToCentavos } from "@/shared/format";

/**
 * Live check while you type: what the customer pays, what you offer the subcontractor (or your driver),
 * and what is left for you. Shows the highest offer that still keeps a 15% margin.
 */
export function QuoteBox({ customerPays, offer, yourCosts, who, id = "quote-box" }: { customerPays: string; offer: string; yourCosts?: string; who?: string; id?: string }) {
  const c = pesosToCentavos(customerPays);
  const o = pesosToCentavos(offer);
  const x = yourCosts ? pesosToCentavos(yourCosts) : 0;
  if (c === null || o === null || x === null || c === 0) {
    return <div className="notice" role="status">Enter the customer rate and your offer to see what is left for you.</div>;
  }
  const q = quote({ customerPaysCentavos: c, offerCentavos: o, yourCostsCentavos: x });
  const tone = q.verdict === "loss" ? "alert" : q.verdict === "thin" ? "notice" : "notice ok-note";
  const pct = q.marginBps === null ? "-" : `${(q.marginBps / 100).toFixed(1)}%`;
  return (
    <div className={tone} role="status" aria-label={who ? `Quote check: ${who}` : "Quote check"} data-testid={id} data-verdict={q.verdict}>
      <dl className="kv" style={{ margin: 0 }}>
        <div><dt>Customer pays</dt><dd>{formatPeso(q.customerPaysCentavos)}</dd></div>
        <div><dt>{who ? `You pay ${who}` : "You offer"}</dt><dd>{formatPeso(q.offerCentavos)}</dd></div>
        {q.yourCostsCentavos > 0 && <div><dt>Costs you cover</dt><dd>{formatPeso(q.yourCostsCentavos)}</dd></div>}
        <div><dt>Left for you</dt><dd><b>{formatPeso(q.profitCentavos)}</b> ({pct})</dd></div>
      </dl>
      <div style={{ marginTop: 8 }}>
        {q.verdict === "loss" && <b>You would lose money on this trip. </b>}
        {q.verdict === "thin" && <b>Thin margin (under 10%). </b>}
        Highest offer that keeps a 15% margin: <b>{formatPeso(q.maxOfferForTargetCentavos(1500))}</b>.
      </div>
    </div>
  );
}
