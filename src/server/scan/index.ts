import net from "node:net";

/**
 * Malware scanning behind an adapter. Two implementations:
 *  - StubScanner (default): NOT a real scanner. It only flags the standard EICAR antivirus test string,
 *    so the quarantine path can be exercised without ClamAV.
 *  - ClamdScanner: speaks the clamd INSTREAM protocol over TCP. Used when CLAMD_HOST is set.
 */
export type ScanResult = { status: "clean" } | { status: "infected"; detail: string } | { status: "error"; detail: string };

export interface Scanner {
  scan(data: Buffer): Promise<ScanResult>;
}

const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

export const stubScanner: Scanner = {
  async scan(data) {
    return data.includes(EICAR) ? { status: "infected", detail: "EICAR-Test-File (stub scanner)" } : { status: "clean" };
  },
};

export class ClamdScanner implements Scanner {
  constructor(
    private host: string,
    private port = 3310,
    private timeoutMs = 30_000,
  ) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let reply = "";
      const done = (r: ScanResult) => {
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(this.timeoutMs, () => done({ status: "error", detail: "clamd timed out" }));
      socket.on("error", (e) => done({ status: "error", detail: `clamd unreachable: ${e.message}` }));
      socket.on("data", (d) => (reply += d.toString("utf8")));
      socket.on("end", () => {
        const text = reply.replace(/\0/g, "").trim();
        if (text.endsWith("OK")) done({ status: "clean" });
        else if (text.endsWith("FOUND")) done({ status: "infected", detail: text.replace(/^stream:\s*/, "").replace(/\s*FOUND$/, "") });
        else done({ status: "error", detail: text || "empty clamd reply" });
      });
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let i = 0; i < data.length; i += 64 * 1024) {
          const chunk = data.subarray(i, i + 64 * 1024);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
    });
  }
}

export function getScanner(): Scanner {
  const host = process.env.CLAMD_HOST;
  return host ? new ClamdScanner(host, Number(process.env.CLAMD_PORT ?? 3310)) : stubScanner;
}
