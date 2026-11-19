import fs from "node:fs";
import EmbeddedPostgres from "embedded-postgres";

/**
 * No-Docker fallback: runs a real PostgreSQL (native binaries) on localhost with the same
 * credentials as docker-compose.yml. Data lives in ./.pgdata. Ctrl+C to stop.
 */
const port = Number(process.env.POSTGRES_PORT ?? 5432);
const databaseDir = ".pgdata";
const fresh = !fs.existsSync(`${databaseDir}/PG_VERSION`);

const pg = new EmbeddedPostgres({
  databaseDir,
  user: "smartload",
  password: "smartload",
  port,
  persistent: true,
  // New clusters are created as UTF8 (the Windows default would be WIN1252, which cannot store the peso sign or most non-Latin names).
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
});

if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("smartload");
console.log(`postgres ready on localhost:${port} (user/password/db: smartload)`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
