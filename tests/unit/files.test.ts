import net from "node:net";
import { describe, expect, it } from "vitest";
import { readExifCapture } from "@/server/files/images";
import { ClamdScanner, stubScanner } from "@/server/scan";
import { backoffMs } from "@/server/jobs/queue";

/** Builds a minimal JPEG whose APP1 segment carries DateTimeOriginal and, optionally, OffsetTimeOriginal. */
function jpegWithExif(when: string | null, offset: string | null): Buffer {
  const ascii = (s: string) => Buffer.from(s + "\0", "latin1");
  const exifEntries: { tag: number; data: Buffer }[] = [];
  if (when) exifEntries.push({ tag: 0x9003, data: ascii(when) });
  if (offset) exifEntries.push({ tag: 0x9011, data: ascii(offset) });

  // TIFF (little endian): header(8) + IFD0(2 + 12 + 4) + ExifIFD(2 + n*12 + 4) + data area
  const ifd0Off = 8;
  const exifOff = ifd0Off + 2 + 12 + 4;
  const dataStart = exifOff + 2 + exifEntries.length * 12 + 4;
  const tiff = Buffer.alloc(dataStart);
  tiff.write("II", 0, "latin1");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(ifd0Off, 4);
  tiff.writeUInt16LE(1, ifd0Off);
  tiff.writeUInt16LE(0x8769, ifd0Off + 2);
  tiff.writeUInt16LE(4, ifd0Off + 4);
  tiff.writeUInt32LE(1, ifd0Off + 6);
  tiff.writeUInt32LE(exifOff, ifd0Off + 10);
  tiff.writeUInt32LE(0, ifd0Off + 14);
  tiff.writeUInt16LE(exifEntries.length, exifOff);
  const data: Buffer[] = [];
  let cursor = dataStart;
  exifEntries.forEach((e, i) => {
    const at = exifOff + 2 + i * 12;
    tiff.writeUInt16LE(e.tag, at);
    tiff.writeUInt16LE(2, at + 2); // ASCII
    tiff.writeUInt32LE(e.data.length, at + 4);
    tiff.writeUInt32LE(cursor, at + 8);
    data.push(e.data);
    cursor += e.data.length;
  });
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff, ...data]);
  const app1 = Buffer.alloc(4);
  app1.writeUInt8(0xff, 0);
  app1.writeUInt8(0xe1, 1);
  app1.writeUInt16BE(body.length + 2, 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app1, body, Buffer.from([0xff, 0xd9])]);
}

describe("readExifCapture", () => {
  it("returns the capture instant when the phone states its UTC offset", () => {
    const d = readExifCapture(jpegWithExif("2026:06:01 10:30:00", "+08:00"));
    expect(d?.toISOString()).toBe("2026-06-01T02:30:00.000Z");
  });

  it("returns null without an offset: a local time alone does not identify an instant, and guessing would invent evidence", () => {
    expect(readExifCapture(jpegWithExif("2026:06:01 10:30:00", null))).toBeNull();
  });

  it("returns null when there is no capture time, or the data is not a JPEG or is damaged", () => {
    expect(readExifCapture(jpegWithExif(null, "+08:00"))).toBeNull();
    expect(readExifCapture(Buffer.from("not an image"))).toBeNull();
    expect(readExifCapture(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x04, 0x00]))).toBeNull();
    expect(readExifCapture(jpegWithExif("garbage", "+08:00"))).toBeNull();
  });
});

describe("malware scanners", () => {
  const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

  it("the stub flags only the EICAR test string", async () => {
    expect(await stubScanner.scan(Buffer.from("hello"))).toEqual({ status: "clean" });
    expect(await stubScanner.scan(Buffer.from(`xx${EICAR}yy`))).toMatchObject({ status: "infected" });
  });

  /** A tiny clamd: reads the INSTREAM framing and answers like the real daemon. */
  function fakeClamd(reply: (payload: Buffer) => string) {
    return new Promise<{ port: number; close: () => void }>((resolve) => {
      const server = net.createServer((sock) => {
        let buf = Buffer.alloc(0);
        sock.on("data", (d) => {
          buf = Buffer.concat([buf, d]);
          const cmd = "zINSTREAM\0".length;
          if (buf.length < cmd) return;
          let off = cmd;
          const chunks: Buffer[] = [];
          for (;;) {
            if (buf.length < off + 4) return;
            const len = buf.readUInt32BE(off);
            if (len === 0) break;
            if (buf.length < off + 4 + len) return;
            chunks.push(buf.subarray(off + 4, off + 4 + len));
            off += 4 + len;
          }
          sock.end(reply(Buffer.concat(chunks)) + "\0");
        });
      });
      server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close() }));
    });
  }

  it("ClamdScanner speaks INSTREAM: clean, infected and error replies, including multi-chunk files", async () => {
    const clamd = await fakeClamd((p) => (p.includes("EICAR") ? "stream: Eicar-Test-Signature FOUND" : p.length === 0 ? "stream: ERROR" : "stream: OK"));
    try {
      const scanner = new ClamdScanner("127.0.0.1", clamd.port);
      expect(await scanner.scan(Buffer.alloc(200_000, 1))).toEqual({ status: "clean" });
      expect(await scanner.scan(Buffer.from(EICAR))).toEqual({ status: "infected", detail: "Eicar-Test-Signature" });
      expect((await scanner.scan(Buffer.alloc(0))).status).toBe("error");
    } finally {
      clamd.close();
    }
  });

  it("ClamdScanner reports an error (never a silent pass) when the daemon is unreachable", async () => {
    const r = await new ClamdScanner("127.0.0.1", 1).scan(Buffer.from("x"));
    expect(r.status).toBe("error");
  });
});

describe("backoffMs", () => {
  it("doubles each attempt and caps at one hour", () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n))).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(backoffMs(30)).toBe(3_600_000);
    expect(backoffMs(2, 1)).toBe(2);
  });
});
