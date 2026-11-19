import globalSetup from "../global-setup";

/** Fresh e2e database (migrations + demo seed) before the app server starts. */
export default async function setup() {
  await globalSetup();
}
