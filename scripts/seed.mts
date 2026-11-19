import { seedOwner } from "../src/server/db/seed";

const { OWNER_EMAIL, OWNER_NAME, OWNER_PASSWORD, COMPANY_NAME } = process.env;
if (!OWNER_EMAIL || !OWNER_PASSWORD) throw new Error("Set OWNER_EMAIL and OWNER_PASSWORD in .env");

const res = await seedOwner({
  companyName: COMPANY_NAME ?? "Lalolu Trucking",
  email: OWNER_EMAIL,
  name: OWNER_NAME ?? "Lalolu Owner",
  password: OWNER_PASSWORD,
});
console.log(res.created ? "company and owner created" : "owner already exists; nothing changed");
