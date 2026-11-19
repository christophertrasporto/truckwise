import { DEMO_PASSWORD, seed } from "../src/server/db/seed";

await seed();
console.log(`demo data seeded; password for every demo account: ${DEMO_PASSWORD}`);
