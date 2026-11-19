import sharp from "sharp";

/** Compressed copy for on-screen viewing. The original is always kept untouched as evidence. */
export async function makeDisplayCopy(original: Buffer): Promise<{ data: Buffer; bytes: number }> {
  const data = await sharp(original, { failOn: "none" })
    .rotate() // honour the camera orientation, then drop the metadata
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 72, mozjpeg: true })
    .toBuffer();
  return { data, bytes: data.length };
}

/**
 * Reads the capture time recorded by the phone in a JPEG's EXIF data (DateTimeOriginal).
 * Returns it ONLY when the file also states its UTC offset (OffsetTimeOriginal), because a local time
 * without an offset does not identify an instant and guessing one would be inventing evidence.
 * Everything else, including missing or unreadable metadata, returns null.
 */
export function readExifCapture(buf: Buffer): Date | null {
  try {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    let off = 2;
    while (off + 4 < buf.length) {
      if (buf[off] !== 0xff) return null;
      const marker = buf[off + 1];
      const len = buf.readUInt16BE(off + 2);
      if (marker === 0xe1 && buf.subarray(off + 4, off + 10).toString("latin1") === "Exif\0\0") {
        return parseTiff(buf.subarray(off + 10, off + 2 + len));
      }
      if (marker === 0xda) return null; // start of scan: no more headers
      off += 2 + len;
    }
  } catch {
    return null;
  }
  return null;
}

function parseTiff(t: Buffer): Date | null {
  const le = t.toString("latin1", 0, 2) === "II";
  const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
  const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
  if (u16(2) !== 42) return null;

  const readIfd = (start: number) => {
    const entries = new Map<number, { type: number; count: number; valueOff: number }>();
    const n = u16(start);
    for (let i = 0; i < n; i++) {
      const e = start + 2 + i * 12;
      entries.set(u16(e), { type: u16(e + 2), count: u32(e + 4), valueOff: e + 8 });
    }
    return entries;
  };
  const ascii = (e: { count: number; valueOff: number }) => {
    const at = e.count <= 4 ? e.valueOff : u32(e.valueOff);
    return t.toString("latin1", at, at + e.count).replace(/\0.*$/, "");
  };

  const ifd0 = readIfd(u32(4));
  const exifPtr = ifd0.get(0x8769);
  if (!exifPtr) return null;
  const exif = readIfd(u32(exifPtr.valueOff));
  const when = exif.get(0x9003); // DateTimeOriginal "YYYY:MM:DD HH:MM:SS"
  const offset = exif.get(0x9011); // OffsetTimeOriginal "+08:00"
  if (!when || !offset) return null;
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ascii(when));
  const o = /^([+-])(\d{2}):(\d{2})$/.exec(ascii(offset));
  if (!m || !o) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${o[1]}${o[2]}:${o[3]}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
