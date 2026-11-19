import { expect, test, type Page } from "@playwright/test";

const PASSWORD = "smartload-demo-1";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function signIn(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("**/app");
}

/** Set SHOTS=<dir> to save screenshots of key screens while the test runs. */
async function shot(page: Page, name: string) {
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/${name}.png`, fullPage: true });
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/login");
}

test("trip goes from creation to ready-for-invoice on a phone-sized screen", async ({ page }) => {
  const reference = `E2E-${Date.now()}`;

  // 1. Dispatcher creates the trip from a manual client request.
  await signIn(page, "dispatcher@acme.test");
  await page.getByRole("link", { name: "New trip" }).first().click();
  await page.getByLabel("Trip reference").fill(reference);
  await page.getByLabel("Cargo description").fill("20 pallets of canned goods");
  await page.getByLabel("Customer contract rate").fill("18,500.00");
  await page.getByLabel("Driver pay (your own driver)").fill("14000");
  await page.getByLabel("Address").first().fill("Calamba, Laguna");
  await page.getByLabel("Address").last().fill("Taguig City");
  await shot(page, "1-new-trip");
  await page.getByRole("button", { name: "Create trip" }).click();
  await page.waitForURL(/\/app\/trips\/[0-9a-f-]{36}$/);
  const tripUrl = page.url();
  const tripId = tripUrl.split("/").pop()!;
  await expect(page.getByRole("heading", { name: reference })).toBeVisible();
  // Staff see the customer contract rate.
  await expect(page.locator("dt", { hasText: "Customer contract rate" })).toBeVisible();
  await expect(page.getByText("₱18,500.00").first()).toBeVisible();

  await shot(page, "2-staff-trip");

  // 2. Broadcast it to all drivers.
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  // 3. Driver sees the offer with payout only, accepts and runs the trip.
  await signIn(page, "driver@acme.test");
  await expect(page.getByText(reference).first()).toBeVisible();
  await expect(page.getByText("₱14,000.00")).toBeVisible();
  await expect(page.getByText(/18,500/)).toHaveCount(0);
  await page.getByText(reference).click();
  await page.waitForURL(tripUrl);

  // Raw API response for the driver must not contain the customer rate under any name.
  const raw = await page.request.get(`/api/trips/${tripId}`);
  expect(raw.status()).toBe(200);
  const rawText = await raw.text();
  expect(rawText).not.toMatch(/contract/i);
  expect(rawText).not.toContain("1850000");
  expect(rawText).toContain("1400000"); // payout is visible to the driver
  // ...and drivers cannot use the dispatch listing at all.
  expect((await page.request.get("/api/trips")).status()).toBe(403);

  await page.getByRole("button", { name: "Accept this trip" }).click();
  for (const step of ["Start trip", "Arrived at pickup", "Cargo loaded", "In transit", "Arrived at destination"]) {
    await page.getByRole("button", { name: step }).click();
  }
  await expect(page.getByRole("heading", { name: "Proof of delivery" })).toBeVisible();
  await shot(page, "3-driver-pod-form");

  // 4. Driver uploads proof: photo + receiver. Delivery time defaults to now but is an explicit, editable field.
  await page.getByLabel("Receiver name").fill("Maria Santos");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Submit proof" }).click();
  await expect(page.getByText("Proof submitted. Dispatch will review it.")).toBeVisible();
  await expect(page.getByText("Awaiting review").first()).toBeVisible();
  await signOut(page);

  // 5. Dispatcher reviews the proof and approves it.
  await signIn(page, "dispatcher@acme.test");
  await page.goto(tripUrl);
  await expect(page.getByText("Maria Santos").first()).toBeVisible();
  await expect(page.getByText("Delivery time (driver-confirmed, unverified)")).toBeVisible();
  await expect(page.getByText("Received by server")).toBeVisible();
  await expect(page.getByRole("img", { name: /Proof photo receipt\.png/ })).toBeVisible();
  await shot(page, "4-review");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for invoice" }).first()).toBeVisible();
  await expect(page.getByText("Proof approved")).toBeVisible();
});

test("another company cannot open this company's trip", async ({ page, request }) => {
  // No session: API refuses.
  expect((await request.get("/api/trips")).status()).toBe(401);
  await signIn(page, "owner@bayan.test");
  const list = await page.request.get("/api/trips");
  expect(list.status()).toBe(200);
  expect(JSON.stringify(await list.json())).not.toContain("canned goods");
});

async function createTripAs(page: Page, reference: string) {
  await page.getByRole("link", { name: "New trip" }).first().click();
  await page.getByLabel("Trip reference").fill(reference);
  await page.getByLabel("Cargo description").fill("Steel coils");
  await page.getByLabel("Customer contract rate").fill("30000");
  await page.getByLabel("Driver pay (your own driver)").fill("21000");
  await page.getByLabel("Address").first().fill("Batangas Port");
  await page.getByLabel("Address").last().fill("Makati City");
  await page.getByRole("button", { name: "Create trip" }).click();
  await page.waitForURL(/\/app\/trips\/[0-9a-f-]{36}$/);
  return page.url();
}

test("a subcontractor accepts with its own truck and driver, who then completes the trip", async ({ page }) => {
  const reference = `E2E-PARTNER-${Date.now()}`;
  await signIn(page, "dispatcher@acme.test");
  const tripUrl = await createTripAs(page, reference);
  await page.getByLabel("Who can take it").selectOption("broadcast_partners");
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  // The subcontractor owner sees the offer (payout only) and accepts with a truck and a driver.
  await signIn(page, "owner@santos.test");
  await expect(page.getByText(reference).first()).toBeVisible();
  await expect(page.getByText(/30,000/)).toHaveCount(0);
  await page.getByText(reference).click();
  await expect(page.getByRole("heading", { name: "Accept for our company" })).toBeVisible();
  await expect(page.locator("#p-truck")).toHaveValue(/.+/);
  await shot(page, "5-partner-accept");
  await expect(page.getByText("₱21,000.00").first()).toBeVisible();
  await page.getByRole("button", { name: "Accept trip" }).click();
  await expect(page.getByText(/Assigned to Santos Driver with truck STS-/)).toBeVisible();
  await signOut(page);

  // Their driver runs the trip. No money is shown to them.
  await signIn(page, "driver@santos.test");
  await page.getByText(reference).click();
  await expect(page.getByText(/payout/i)).toHaveCount(0);
  for (const step of ["Start trip", "Arrived at pickup", "Cargo loaded", "In transit", "Arrived at destination"]) {
    await page.getByRole("button", { name: step }).click();
  }
  await page.getByLabel("Receiver name").fill("Warehouse clerk");
  await page.locator('input[type="file"]').first().setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Submit proof" }).click();
  await expect(page.getByText("Proof submitted. Dispatch will review it.")).toBeVisible();
  await signOut(page);

  await signIn(page, "dispatcher@acme.test");
  await page.goto(tripUrl);
  await expect(page.getByText(/Santos Driver \(Santos Trucking/)).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for invoice" }).first()).toBeVisible();
});

test("with approval required, accepting sends a request that dispatch approves", async ({ page }) => {
  const reference = `E2E-APPROVAL-${Date.now()}`;
  await signIn(page, "owner@acme.test");
  await page.goto("/app/settings");
  await page.getByLabel(/Dispatch approves first/).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  const tripUrl = await createTripAs(page, reference);
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  await signIn(page, "driver@acme.test");
  await expect(page.getByText(reference).first()).toBeVisible();
  await shot(page, "7-driver-board");
  await page.getByText(reference).click();
  await expect(page.locator("#truck")).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Accept this trip" }).click();
  await expect(page.getByText("Request sent. Dispatch will confirm it.")).toBeVisible();
  await signOut(page);

  await signIn(page, "owner@acme.test");
  await page.goto(tripUrl);
  await expect(page.getByRole("heading", { name: /Requests to take this trip/ })).toBeVisible();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText(/Acme Driver · ACM-/).first()).toBeVisible();

  // Put the company back to immediate acceptance for any later test.
  await page.goto("/app/settings");
  await page.getByLabel(/Assign immediately/).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("fleet, calendar, subcontractor and settings screens load for the owner", async ({ page }) => {
  await signIn(page, "owner@acme.test");
  for (const [path, heading] of [
    ["/app/fleet", "Fleet"],
    ["/app/calendar", "Dispatch calendar"],
    ["/app/partners", "Subcontractors"],
    ["/app/settings", "Dispatch settings"],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
  }
  await page.goto("/app/fleet");
  await expect(page.getByText("ACM-101")).toBeVisible();
  await shot(page, "6-fleet");
  // A driver has no access to the fleet or the subcontractor list.
  await signOut(page);
  await signIn(page, "driver@acme.test");
  await page.goto("/app/partners");
  await expect(page.getByText("Your role does not include subcontractors.")).toBeVisible();
});

async function drawSignature(page: Page, scope = page.locator("canvas").first()) {
  await scope.scrollIntoViewIfNeeded(); // mouse coordinates are viewport-relative
  const box = (await scope.boundingBox())!;
  await page.mouse.move(box.x + 20, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 100, { steps: 8 });
  await page.mouse.move(box.x + 220, box.y + 50, { steps: 8 });
  await page.mouse.up();
}

async function driveToDestination(page: Page, reference: string) {
  await signIn(page, "driver@acme.test");
  await page.getByText(reference).click();
  await expect(page.locator("#truck")).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Accept this trip" }).click();
  for (const step of ["Start trip", "Arrived at pickup", "Cargo loaded", "In transit", "Arrived at destination"]) {
    await page.getByRole("button", { name: step }).click();
  }
}

test("a proof filled in with no signal is saved on the phone and uploads itself when the connection returns", async ({ page, context }) => {
  const reference = `E2E-OFFLINE-${Date.now()}`;
  await signIn(page, "dispatcher@acme.test");
  const tripUrl = await createTripAs(page, reference);
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  await driveToDestination(page, reference);
  const form = page.getByRole("form", { name: /Proof for delivery 1/ });
  await expect(form).toBeVisible();

  // The signal drops. The driver still fills in everything, including a signature.
  await context.setOffline(true);
  await form.getByLabel("Receiver name").fill("Night guard");
  await form.locator('input[type="file"]').first().setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await drawSignature(page);
  await shot(page, "8-offline-form");
  await form.getByRole("button", { name: "Submit proof" }).click();
  await expect(page.getByTestId("pod-waiting")).toBeVisible();
  await expect(page.getByTestId("offline-waiting")).toBeVisible();
  await shot(page, "9-offline-waiting");

  // The signal returns: the phone uploads on its own.
  await context.setOffline(false);
  await expect(page.getByText("Proof submitted. Dispatch will review it.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("offline-waiting")).toHaveCount(0);
  await signOut(page);

  // Dispatch sees it was sent from the offline queue, with the clocks kept apart, plus the signature and a display copy.
  await signIn(page, "dispatcher@acme.test");
  await page.goto(tripUrl);
  await expect(page.getByText("Sent from the phone offline queue")).toBeVisible();
  await expect(page.getByText(/device-reported, not verified/)).toBeVisible();
  await expect(page.getByText("Delivery time (driver-confirmed, unverified)")).toBeVisible();
  await expect(page.getByText("Received by server")).toBeVisible();
  await expect(page.getByRole("img", { name: "Receiver signature" })).toBeVisible();
  await expect(page.locator('img[src*="display.jpg"]').first()).toBeVisible({ timeout: 20_000 });
  await shot(page, "10-review-offline");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.locator(".chip", { hasText: "Ready for invoice" }).first()).toBeVisible();
});

test("a trip with two delivery stops needs proof for each stop and completes when both are approved", async ({ page }) => {
  const reference = `E2E-STOPS-${Date.now()}`;
  await signIn(page, "dispatcher@acme.test");
  await page.getByRole("link", { name: "New trip" }).first().click();
  await page.getByLabel("Trip reference").fill(reference);
  await page.getByLabel("Cargo description").fill("Mixed pallets");
  await page.getByLabel("Customer contract rate").fill("40000");
  await page.getByLabel("Driver pay (your own driver)").fill("28000");
  await page.getByRole("button", { name: "Add stop" }).click();
  await page.locator("#a0").fill("Batangas Port");
  await page.locator("#a1").fill("Makati warehouse");
  await page.locator("#a2").fill("Pasay warehouse");
  await page.getByRole("button", { name: "Create trip" }).click();
  await page.waitForURL(/\/app\/trips\/[0-9a-f-]{36}$/);
  const tripUrl = page.url();
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  await driveToDestination(page, reference);
  for (const n of [1, 2]) {
    const form = page.getByRole("form", { name: new RegExp(`Proof for delivery ${n}$`) });
    await expect(form).toBeVisible();
    await form.getByLabel("Receiver name").fill(`Receiver ${n}`);
    await form.locator('input[type="file"]').first().setInputFiles({ name: `r${n}.png`, mimeType: "image/png", buffer: PNG });
    await form.getByRole("button", { name: "Submit proof" }).click();
    if (n === 1) await expect(page.getByText(/1 of 2 have proof/)).toBeVisible();
  }
  await expect(page.getByText("Proof submitted. Dispatch will review it.")).toBeVisible();
  await signOut(page);

  await signIn(page, "dispatcher@acme.test");
  await page.goto(tripUrl);
  await expect(page.getByText("Receiver 1")).toBeVisible();
  await expect(page.getByText("Receiver 2")).toBeVisible();
  // Files are checked in the background and approval waits for that, so retry until each approval is accepted.
  for (let i = 0; i < 2; i++) {
    await expect(async () => {
      await page.reload();
      const [res] = await Promise.all([
        page.waitForResponse((r) => r.url().includes("/api/pod/") && r.url().endsWith("/review")),
        page.getByRole("button", { name: "Approve", exact: true }).first().click(),
      ]);
      expect(res.status()).toBe(200);
    }).toPass({ timeout: 30_000 });
  }
  await expect(page.locator(".chip", { hasText: "Ready for invoice" }).first()).toBeVisible();
});

test("with automatic approval switched on, a clean signed delivery is approved by policy", async ({ page }) => {
  const reference = `E2E-AUTO-${Date.now()}`;
  await signIn(page, "owner@acme.test");
  await page.goto("/app/settings");
  await page.getByLabel(/Approve clean, complete deliveries automatically/).check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  const tripUrl = await createTripAs(page, reference);
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  await driveToDestination(page, reference);
  const form = page.getByRole("form", { name: /Proof for delivery 1/ });
  await form.getByLabel("Receiver name").fill("Store manager");
  await form.locator('input[type="file"]').first().setInputFiles({ name: "r.png", mimeType: "image/png", buffer: PNG });
  await drawSignature(page);
  await form.getByRole("button", { name: "Submit proof" }).click();
  await expect(page.getByText("Proof submitted. Dispatch will review it.").or(page.getByText("Delivery approved. Thank you."))).toBeVisible();
  await signOut(page);

  await signIn(page, "owner@acme.test");
  await expect(async () => {
    await page.goto(tripUrl);
    await expect(page.getByText("Automatic approval (company policy)")).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 40_000 });
  await expect(page.locator(".chip", { hasText: "Ready for invoice" }).first()).toBeVisible();

  await page.goto("/app/settings");
  await page.getByLabel(/Approve clean, complete deliveries automatically/).uncheck();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("the app can be installed: manifest, icons and service worker are served", async ({ request }) => {
  const m = await request.get("/manifest.webmanifest");
  expect(m.status()).toBe(200);
  const manifest = await m.json();
  expect(manifest).toMatchObject({ name: "Truckwise", display: "standalone", start_url: "/app" });
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
  const sw = await request.get("/sw.js");
  expect(sw.status()).toBe(200);
  expect(await sw.text()).toContain("lalolu-proof-sync");
});

/** Creates a trip, has the company driver (or the subcontractor) deliver it, and has dispatch approve the proof. Returns the trip URL. */
async function makeReadyTrip(page: Page, reference: string, via: "internal" | "partner" = "internal", rate = "18500", payout = "14000") {
  await signIn(page, "dispatcher@acme.test");
  await page.getByRole("link", { name: "New trip" }).first().click();
  await page.getByLabel("Trip reference").fill(reference);
  await page.getByLabel("Cargo description").fill("Steel coils");
  await page.getByLabel("Customer contract rate").fill(rate);
  await page.getByLabel("Driver pay (your own driver)").fill(payout);
  await page.getByLabel("Address").first().fill("Batangas Port");
  await page.getByLabel("Address").last().fill("Makati City");
  await page.getByRole("button", { name: "Create trip" }).click();
  await page.waitForURL(/\/app\/trips\/[0-9a-f-]{36}$/);
  const tripUrl = page.url();
  if (via === "partner") await page.getByLabel("Who can take it").selectOption("broadcast_partners");
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  if (via === "partner") {
    await signIn(page, "owner@santos.test");
    await page.getByText(reference).click();
    await expect(page.locator("#p-truck")).toHaveValue(/.+/);
    await page.getByRole("button", { name: "Accept trip" }).click();
    await expect(page.getByText(/Assigned to Santos Driver with truck STS-/)).toBeVisible();
    await signOut(page);
    await signIn(page, "driver@santos.test");
    await page.getByText(reference).click();
  } else {
    await signIn(page, "driver@acme.test");
    await page.getByText(reference).click();
    await expect(page.locator("#truck")).toHaveValue(/.+/);
    await page.getByRole("button", { name: "Accept this trip" }).click();
  }
  for (const step of ["Start trip", "Arrived at pickup", "Cargo loaded", "In transit", "Arrived at destination"]) {
    await page.getByRole("button", { name: step }).click();
  }
  const form = page.getByRole("form", { name: /Proof for delivery 1/ });
  await form.getByLabel("Receiver name").fill("Warehouse clerk Reyes");
  await form.locator('input[type="file"]').first().setInputFiles({ name: "receipt.png", mimeType: "image/png", buffer: PNG });
  await drawSignature(page);
  await form.getByRole("button", { name: "Submit proof" }).click();
  await expect(page.getByText("Proof submitted. Dispatch will review it.")).toBeVisible();
  await signOut(page);

  await signIn(page, "dispatcher@acme.test");
  await page.goto(tripUrl);
  // Files are checked in the background and approval waits for that, so retry until it is accepted.
  await expect(async () => {
    await page.reload();
    const [res] = await Promise.all([
      page.waitForResponse((r) => r.url().includes("/api/pod/") && r.url().endsWith("/review")),
      page.getByRole("button", { name: "Approve", exact: true }).first().click(),
    ]);
    expect(res.status()).toBe(200);
  }).toPass({ timeout: 30_000 });
  await expect(page.locator(".chip", { hasText: "Ready for invoice" }).first()).toBeVisible();
  await signOut(page);
  return tripUrl;
}

/** Tick only the given trip in a "ready" list (other finished trips may be waiting there from earlier tests). */
async function pickOnly(group: ReturnType<Page["locator"]>, reference: string) {
  const boxes = group.getByRole("checkbox");
  for (let i = 0; i < (await boxes.count()); i++) await boxes.nth(i).uncheck();
  await group.getByRole("checkbox", { name: new RegExp(reference) }).check();
}

test("the accountant issues an invoice with the proof attached, downloads the PDF and records payment", async ({ page }) => {
  const reference = `E2E-INV-${Date.now()}`;
  const tripUrl = await makeReadyTrip(page, reference);
  void tripUrl;

  // Dispatch does not handle invoices at all.
  await signIn(page, "dispatcher@acme.test");
  expect((await page.request.get("/api/invoices")).status()).toBe(403);
  await page.goto("/app/invoices");
  await expect(page.getByText("Your role does not include invoices.")).toBeVisible();
  await signOut(page);

  await signIn(page, "accountant@acme.test");
  await page.getByRole("link", { name: "Invoices" }).click();
  const group = page.getByRole("region", { name: /Ready to invoice: Mega Mart/ });
  await expect(group).toBeVisible();
  await pickOnly(group, reference);
  await shot(page, "11-ready-to-invoice");
  await group.getByRole("button", { name: /Issue invoice/ }).click();
  await page.waitForURL(/\/app\/invoices\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /^INV-\d{4}-\d{4}$/ })).toBeVisible();
  await expect(page.getByText(reference).first()).toBeVisible();
  // The approved proof is attached: receiver, photo and signature.
  await expect(page.getByText(/Received by Warehouse clerk Reyes/)).toBeVisible();
  await expect(page.getByRole("img", { name: "Receiver signature" })).toBeVisible();
  await expect(page.getByRole("img", { name: /Proof photo/ }).first()).toBeVisible();
  await expect(page.getByText("₱18,500.00").first()).toBeVisible();
  await shot(page, "12-invoice");

  // The PDF is a real document with the proof pages.
  const pdfUrl = (await page.getByRole("link", { name: /Download PDF/ }).getAttribute("href"))!;
  const pdf = await page.request.get(pdfUrl);
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()["content-type"]).toBe("application/pdf");
  const body = await pdf.body();
  expect(body.subarray(0, 5).toString()).toBe("%PDF-");
  expect(body.length).toBeGreaterThan(5_000);

  await page.getByLabel(/Payment reference/).fill("BPI 0042");
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.locator(".chip", { hasText: "paid" }).first()).toBeVisible();

  // Billed trips leave the ready list: nothing is billed twice.
  await page.goto("/app/invoices");
  await expect(page.getByRole("checkbox", { name: new RegExp(reference) })).toHaveCount(0);
});

test("a driver's expense is reviewed by finance, reduces trip profit, and the driver sees only their own earnings", async ({ page }) => {
  const reference = `E2E-EXP-${Date.now()}`;
  const tripUrl = await makeReadyTrip(page, reference, "internal", "20000", "12000");

  await signIn(page, "driver@acme.test");
  await page.goto(tripUrl);
  await page.getByLabel("Amount (PHP)").fill("1,250");
  await page.locator("#x-receipt").setInputFiles({ name: "fuel.png", mimeType: "image/png", buffer: PNG });
  await page.getByRole("button", { name: "Send for review" }).click();
  await expect(page.getByText("Sent for review. The office will confirm it.")).toBeVisible();
  await expect(page.getByText("Waiting for review")).toBeVisible();
  // Earnings: payout only, never the customer rate or profit.
  await page.goto("/app/earnings");
  await expect(page.getByText(reference).first()).toBeVisible();
  await expect(page.getByText("₱12,000.00").first()).toBeVisible();
  const earnings = await page.request.get("/api/earnings");
  expect(earnings.status()).toBe(200);
  const earningsText = await earnings.text();
  expect(earningsText).not.toMatch(/contract|profit|margin/i);
  expect(JSON.parse(earningsText).trips.some((t: { payoutCentavos: number }) => t.payoutCentavos === 2_000_000)).toBe(false); // the customer charge is not shown as a payout
  expect((await page.request.get("/api/finance/profit")).status()).toBe(403);
  expect((await page.request.get("/api/invoices")).status()).toBe(403);
  await signOut(page);

  await signIn(page, "accountant@acme.test");
  await page.getByRole("link", { name: "Expenses", exact: true }).click();
  const card = page.getByRole("region", { name: new RegExp(`Expense fuel ${reference}`) });
  await expect(card).toBeVisible();
  await shot(page, "13-expense-review");
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("region", { name: new RegExp(`Expense fuel ${reference}`) })).toHaveCount(0);

  await page.getByRole("link", { name: "Profit", exact: true }).click();
  const row = page.getByRole("row", { name: new RegExp(reference) });
  await expect(row).toBeVisible();
  // 20,000 charge - 12,000 driver pay - 1,250 fuel the company pays (the trip's payout does not include fuel) = 6,750
  await expect(row).toContainText("₱6,750.00");
  await shot(page, "14-profit");
});

test("a subcontractor sees the settlement for its own trips, with no customer rate or profit anywhere", async ({ page }) => {
  const reference = `E2E-SET-${Date.now()}`;
  await makeReadyTrip(page, reference, "partner", "30000", "21000");

  await signIn(page, "accountant@acme.test");
  await page.getByRole("link", { name: "Settlements" }).click();
  const group = page.getByRole("region", { name: /Ready to settle: Santos Trucking/ });
  await expect(group).toBeVisible();
  await pickOnly(group, reference);
  await group.getByRole("button", { name: /Create settlement/ }).click();
  await page.waitForURL(/\/app\/settlements\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { name: /^SET-\d{4}-\d{4}$/ })).toBeVisible();
  await expect(page.getByText("₱21,000.00").first()).toBeVisible();
  await page.getByLabel(/Payment reference/).fill("GCash 777");
  await page.getByRole("button", { name: "Mark as paid" }).click();
  await expect(page.locator(".chip", { hasText: "paid" }).first()).toBeVisible();
  await signOut(page);

  await signIn(page, "owner@santos.test");
  await page.getByRole("link", { name: "Settlements" }).click();
  await expect(page.getByText(/From Acme Haulers/).first()).toBeVisible();
  await page.getByText(/^SET-/).first().click();
  await expect(page.getByText(reference).first()).toBeVisible();
  await expect(page.getByText("₱21,000.00").first()).toBeVisible();
  const text = await page.locator("main.shell-main").innerText();
  expect(text).not.toMatch(/30,000|contract|profit|margin/i);
  for (const url of ["/api/finance/profit", "/api/invoices", "/api/settlements"]) expect((await page.request.get(url)).status()).toBe(403);
  const mine = await page.request.get("/api/partner/settlements");
  expect(mine.status()).toBe(200);
  expect(await mine.text()).not.toMatch(/contract|30000/i);
});

test("alerts: a new offer reaches the driver, opening it clears it, and dispatch hears when the driver accepts and arrives", async ({ page }) => {
  const reference = `E2E-ALERT-${Date.now()}`;
  await signIn(page, "dispatcher@acme.test");
  const tripUrl = await createTripAs(page, reference);
  await page.getByRole("button", { name: "Send offer" }).click();
  await expect(page.locator(".chip", { hasText: "Offered" }).first()).toBeVisible();
  await signOut(page);

  await signIn(page, "driver@acme.test");
  // The background worker runs right after the offer is sent; the badge appears without anyone refreshing a job queue.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId("unread-badge")).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("link", { name: /Alerts/ }).click();
  await page.waitForURL("**/app/notifications");
  const item = page.getByRole("button", { name: new RegExp(`Unread: New trip available. ${reference}`) });
  await expect(item).toBeVisible();
  await shot(page, "15-alerts");
  await item.click(); // opens the trip and marks it read
  await page.waitForURL(tripUrl);
  await page.goto("/app/notifications");
  await expect(page.getByRole("button", { name: new RegExp(`^New trip available. ${reference}`) })).toBeVisible(); // now read: no "Unread" prefix

  await page.goto(tripUrl);
  await expect(page.locator("#truck")).toHaveValue(/.+/);
  await page.getByRole("button", { name: "Accept this trip" }).click();
  await page.getByRole("button", { name: "Start trip" }).click();
  await page.getByRole("button", { name: "Arrived at pickup" }).click();
  await expect(page.getByRole("button", { name: "Cargo loaded" })).toBeVisible();
  await signOut(page);

  await signIn(page, "dispatcher@acme.test");
  await page.goto("/app/notifications");
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole("button", { name: new RegExp(`Trip accepted. Acme Driver accepted ${reference}`) })).toBeVisible({ timeout: 2000 });
    await expect(page.getByRole("button", { name: new RegExp(`Driver at pickup. Acme Driver arrived at the pickup for ${reference}`) })).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  // alerts carry no money
  expect(await page.locator("main.shell-main").innerText()).not.toMatch(/₱|PHP|18,500|payout/i);
});

test("a person can save a mobile number for text alerts, and bad numbers are refused", async ({ page }) => {
  await signIn(page, "driver@acme.test");
  await page.goto("/app/account");
  await expect(page.getByRole("heading", { name: "Alerts", exact: true })).toBeVisible();
  await page.getByLabel("Mobile number").fill("12345");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.locator(".alert").first()).toContainText("Philippine mobile number");
  await page.getByLabel("Mobile number").fill("0917 555 1234");
  await page.getByLabel(/Text me when something urgent/).check();
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.getByLabel("Mobile number")).toHaveValue("+63 917 555 1234");
  await page.reload();
  await expect(page.getByLabel("Mobile number")).toHaveValue("+63 917 555 1234");
  await expect(page.getByLabel(/Text me when something urgent/)).toBeChecked();
  // Honest about the stub provider.
  await expect(page.getByText(/Text messages are not connected on this server yet/)).toBeVisible();
});
