"use client";

import { useEffect, useRef, useState } from "react";

/** Receiver signature: draw with a finger or mouse; reports a PNG blob (or null when empty). */
export function SignaturePad({ onChange, initial }: { onChange: (png: Blob | null) => void; initial?: Blob | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const strokes = useRef(0);
  const [empty, setEmpty] = useState(!initial);

  useEffect(() => {
    const c = ref.current!;
    const ratio = window.devicePixelRatio || 1;
    c.width = c.clientWidth * ratio;
    c.height = c.clientHeight * ratio;
    const ctx = c.getContext("2d")!;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0b1220";
    if (initial) {
      const url = URL.createObjectURL(initial);
      const img = new Image();
      img.onload = () => {
        ctx.drawImage(img, 0, 0, c.clientWidth, c.clientHeight);
        URL.revokeObjectURL(url);
      };
      img.src = url;
    }
  }, [initial]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    const ctx = ref.current!.getContext("2d")!;
    const p = point(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = ref.current!.getContext("2d")!;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  };
  const up = () => {
    if (!drawing.current) return;
    drawing.current = false;
    strokes.current += 1;
    setEmpty(false);
    ref.current!.toBlob((b) => onChange(b), "image/png");
  };
  const clear = () => {
    const c = ref.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    strokes.current = 0;
    setEmpty(true);
    onChange(null);
  };

  return (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor="signature-pad">Receiver signature (optional)</label>
      <canvas
        id="signature-pad"
        ref={ref}
        aria-label="Signature area. Draw the receiver's signature here."
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        style={{ width: "100%", height: 160, border: "1px dashed var(--line)", borderRadius: 12, background: "#fff", touchAction: "none" }}
      />
      <div className="actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={clear} disabled={empty}>Clear signature</button>
        <span className="muted">{empty ? "Not signed" : "Signed"}</span>
      </div>
    </div>
  );
}
