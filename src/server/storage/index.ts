import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Object storage behind one interface. Only the local-disk implementation exists so far
 * (dev and single-server use). An S3/MinIO implementation is a later swap behind this
 * interface; see docs/PROGRESS.md. Keys are always prefixed `tenants/{tenantId}/`.
 */
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Short-lived URL. Call ONLY after an authorization check for the object. */
  signedUrl(key: string, ttlSeconds: number): string;
}

const root = () => path.resolve(/*turbopackIgnore: true*/ process.env.STORAGE_DIR ?? ".storage");
const secret = () => {
  const s = process.env.STORAGE_SIGNING_SECRET;
  if (!s) throw new Error("STORAGE_SIGNING_SECRET is not set");
  return s;
};

function safePath(key: string): string {
  const full = path.resolve(/*turbopackIgnore: true*/ root(), key);
  if (!full.startsWith(root() + path.sep)) throw new Error("invalid storage key");
  return full;
}

const sign = (key: string, exp: number) => createHmac("sha256", secret()).update(`${key}|${exp}`).digest("hex");

export function verifySignedRequest(key: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const expected = Buffer.from(sign(key, exp));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const storage: ObjectStorage = {
  async put(key, data) {
    const file = safePath(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  },
  get: (key) => readFile(safePath(key)),
  signedUrl(key, ttlSeconds) {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    return `/api/files/${key.split("/").map(encodeURIComponent).join("/")}?exp=${exp}&sig=${sign(key, exp)}`;
  },
};

export const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");

export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/** Detects the real type from magic bytes. The filename and the client's MIME header are ignored. */
export function sniffImage(data: Buffer): { mime: string; ext: string } | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { mime: "image/jpeg", ext: "jpg" };
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { mime: "image/png", ext: "png" };
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP")
    return { mime: "image/webp", ext: "webp" };
  return null;
}
