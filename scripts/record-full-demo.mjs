// Single CONTINUOUS demo recording of the full «Поливайко» user journey — a
// human-watchable screencast for the homework demo. This is DELIBERATELY NOT the
// per-capability proof harness (scripts/record-demos.mjs): that records 6 short,
// assertion-gated clips (one per capability) into the manifest. This records ONE
// continuous .webm that walks the whole flow end-to-end on a single page, paced
// so a person can follow along.
//
// It REUSES the proof harness's server lifecycle wholesale so it never touches
// dev data:
//   - seeds a DEDICATED demo SQLite file (DEMO_DATABASE_URL, default
//     data/demo.db) via scripts/seed-demo-db.mjs — same migrations + same
//     deterministic fixture as the E2E layer;
//   - builds (unless SKIP_BUILD=1) and boots its OWN `next start` on a DEDICATED
//     port (DEMO_PORT, default 3200) handed that same DATABASE_URL;
//   - drives headless Chromium with Playwright's context-level recordVideo so the
//     whole journey lands in ONE video file;
//   - tears the server down on exit.
// When BASE_URL is set, it drives that already-running server and skips
// build/seed/boot/teardown.
//
// Output: docs/qa/demo-recordings/full-demo/poliaivko-full-demo.webm (the single
// playable webm; Playwright names videos by a hash internally, so after closing
// the context we rename the produced file to this stable name and remove any
// stray intermediate videos). It does NOT write/touch the 6 per-capability clips
// or the manifest.json next to them.
//
// Run: `node scripts/record-full-demo.mjs`
//   env: DEMO_PORT, DEMO_DATABASE_URL, SKIP_BUILD=1 (reuse an existing .next),
//        BASE_URL (drive an already-running server; then no build/seed/teardown),
//        PACE (multiplier for all pauses, default 1).
import { chromium } from "@playwright/test";
import { mkdir, rm, rename, readdir } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const OUT_DIR = join("docs/qa", "demo-recordings", "full-demo");
const FINAL_VIDEO = join(OUT_DIR, "poliaivko-full-demo.webm");
const PORT = process.env.DEMO_PORT ?? "3200";
const DEMO_DB_URL = process.env.DEMO_DATABASE_URL ?? "file:./data/demo.db";
const EXTERNAL_BASE_URL = process.env.BASE_URL ?? null;
const BASE_URL = EXTERNAL_BASE_URL ?? `http://localhost:${PORT}`;
const PACE = Number(process.env.PACE ?? 1);

// One desktop viewport for the whole continuous take.
const VIEWPORT = { width: 1280, height: 800 };

const assert = (cond, msg) => {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
};

// `pause` paces the screencast so a human can follow each step. `beat` is a
// short between-steps pause; `settle` waits for the network to go idle then a
// longer pause to let async content (the Recharts SVGs) render.
const pause = (page, ms) => page.waitForTimeout(Math.round(ms * PACE));
const beat = (page) => pause(page, 1000); // ~1s between steps
const settle = async (page, ms = 2000) => {
  await page.waitForLoadState("networkidle").catch(() => {});
  await pause(page, ms);
};
// A gentle, watchable scroll to a y offset (instead of a teleporting jump).
const smoothScrollTo = async (page, y) => {
  await page.evaluate((target) => {
    window.scrollTo({ top: target, behavior: "smooth" });
  }, y);
  await page.waitForTimeout(Math.round(900 * PACE));
};

// ---- Ukrainian copy the journey drives + locates by (mirrors lib/i18n/uk.ts;
// this .mjs deliberately avoids the TS import so it stays a plain node script).
const UK = {
  listTitle: "Мої рослини",
  add: "Додати рослину",
  save: "Зберегти",
  nameLabel: "Назва",
  speciesLabel: "Вид",
  acquiredDateLabel: "Дата придбання",
  intervalLabel: "Інтервал поливу (днів)",
  summaryLabel: "Сьогодні полити",
  sectionTitle: "Потребують поливу",
  waterNow: "Полити зараз",
  brand: "Поливайко",
  growthAdd: "Записати вимірювання",
  growthHeightLabel: "Висота (см)",
  growthUnit: "см",
  growthSectionTitle: "Вимірювання росту",
  wateringAdd: "Записати полив",
  wateringNoteLabel: "Нотатка",
  wateringSectionTitle: "Поливи",
  growthChartTitle: "Графік росту рослини",
  wateringChartTitle: "Графік поливів рослини",
  seededHealthyName: "Здорова на підвіконні", // the richly-seeded demo plant
};

/**
 * Resolve the richly-seeded demo plant id (2 measurements + 2 waterings) by
 * reading its card link on the seeded home; fall back to the first numeric
 * /plants/{id} link. The harness owns a fresh DB, so ids are not hardcoded.
 */
async function resolveSeededPlantId(page) {
  const seededHref = await page
    .getByRole("link", { name: new RegExp(UK.seededHealthyName) })
    .first()
    .getAttribute("href")
    .catch(() => null);
  const seeded = seededHref && seededHref.match(/^\/plants\/(\d+)(?:[/?#]|$)/);
  if (seeded) return seeded[1];

  const hrefs = await page
    .locator('a[href^="/plants/"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("href")));
  for (const href of hrefs) {
    const m = href && href.match(/^\/plants\/(\d+)(?:[/?#]|$)/);
    if (m) return m[1];
  }
  throw new Error("could not resolve a seeded plant id from the home grid");
}

// ---- the continuous journey. Assertions are LIGHT (this is a screencast, not a
// gate) but DO pin a few key milestones so a broken flow fails loudly instead of
// silently recording a broken run.
async function driveJourney(page) {
  // STEP 1 — Land on the home «Поливайко». Show the «Сьогодні полити» summary
  // count and the «Потребують поливу» reminder rows; scroll a little so the
  // cards + status pills come into view.
  await page.goto(BASE_URL);
  await settle(page);
  assert(
    await page.getByText(UK.summaryLabel).isVisible(),
    "MILESTONE 1: «Сьогодні полити» summary card is visible on the home",
  );
  assert(
    await page.getByRole("heading", { name: UK.sectionTitle }).isVisible(),
    "MILESTONE 1: «Потребують поливу» reminder section is visible",
  );
  const dueBefore = await page.getByRole("button", { name: UK.waterNow }).count();
  assert(
    dueBefore >= 1,
    `MILESTONE 1: at least one due «Полити зараз» row present (got ${dueBefore})`,
  );
  await beat(page);
  await smoothScrollTo(page, 320); // bring the reminder rows + status pills into frame
  await settle(page);
  await smoothScrollTo(page, 0);
  await beat(page);

  // STEP 2 — Water a due plant. Show the count decrement + the row resolving.
  await page.getByRole("button", { name: UK.waterNow }).first().click();
  const expected = dueBefore - 1;
  await page
    .locator("div", { hasText: UK.summaryLabel })
    .last()
    .getByText(String(expected), { exact: true })
    .waitFor({ state: "visible" });
  const dueAfter = await page.getByRole("button", { name: UK.waterNow }).count();
  assert(
    dueAfter === expected,
    `MILESTONE 2: water-now decremented the due count (${dueBefore} -> ${dueAfter}, expected ${expected})`,
  );
  await settle(page); // pause so the refreshed home in the AFTER state is visible
  await beat(page);

  // STEP 3 — Add a new plant via /plants/new. Fill name + species + acquired
  // date + watering interval, submit, and land on the list showing the new card.
  const newName = `Демонстраційна рослина ${Date.now()}`;
  await page.goto(`${BASE_URL}/plants/new`);
  await settle(page, 800);
  await page.getByLabel(UK.nameLabel).fill(newName);
  await beat(page);
  await page.getByLabel(UK.speciesLabel).fill("Ficus lyrata");
  await beat(page);
  // The acquired-date control is an HTML date input (YYYY-MM-DD), matching the
  // E2E suite's usage. Use a recent past date.
  await page.getByLabel(UK.acquiredDateLabel).fill("2026-05-01");
  await beat(page);
  await page.getByLabel(UK.intervalLabel).fill("9");
  await beat(page);
  await page.getByRole("button", { name: UK.save }).click();
  await page
    .getByRole("heading", { name: newName, level: 2 })
    .waitFor({ state: "visible" });
  assert(
    await page.getByRole("heading", { name: newName, level: 2 }).isVisible(),
    "MILESTONE 3: the newly added plant card appears on the list",
  );
  await settle(page);
  await beat(page);

  // STEP 4 — Open the richly-seeded plant's detail (it carries history). Show
  // the growth measurements list + the watering list.
  await page.goto(BASE_URL);
  await settle(page, 800);
  const healthyId = await resolveSeededPlantId(page);
  await page.goto(`${BASE_URL}/plants/${healthyId}`);
  await settle(page);
  assert(
    await page.getByRole("heading", { name: UK.growthSectionTitle }).isVisible(),
    "MILESTONE 4: «Вимірювання росту» (growth) section renders on the detail",
  );
  assert(
    await page.getByRole("heading", { name: UK.wateringSectionTitle }).isVisible(),
    "MILESTONE 4: «Поливи» (watering) section renders on the detail",
  );
  // Scroll down a little so the measurement + watering lists are clearly in view.
  await smoothScrollTo(page, 360);
  await settle(page);
  await beat(page);

  // STEP 5 — Log a measurement (decimal comma 38,5 -> 38.5 см) then a watering
  // with a note; show each appear.
  await page.getByLabel(UK.growthHeightLabel).scrollIntoViewIfNeeded();
  await page.getByLabel(UK.growthHeightLabel).fill("38,5");
  await beat(page);
  await page.getByRole("button", { name: UK.growthAdd }).click();
  await page.getByText(`38.5 ${UK.growthUnit}`).waitFor({ state: "visible" });
  assert(
    await page.getByText(`38.5 ${UK.growthUnit}`).isVisible(),
    "MILESTONE 5: the new measurement «38.5 см» appears in the growth list",
  );
  await settle(page);
  await beat(page);

  const note = `Демонстраційний полив ${Date.now()}`;
  await page.getByLabel(UK.wateringNoteLabel).scrollIntoViewIfNeeded();
  await page.getByLabel(UK.wateringNoteLabel).fill(note);
  await beat(page);
  await page.getByRole("button", { name: UK.wateringAdd }).click();
  await page.getByText(note).waitFor({ state: "visible" });
  assert(
    await page.getByText(note).isVisible(),
    "MILESTONE 5: the new watering note appears in the watering list",
  );
  await settle(page);
  await beat(page);

  // STEP 6 — Scroll to the charts and PAUSE so both render and are clearly
  // visible. Verify each chart figure painted an <svg> before the chart pause.
  const growth = page.getByRole("figure", { name: UK.growthChartTitle });
  const watering = page.getByRole("figure", { name: UK.wateringChartTitle });
  await growth.scrollIntoViewIfNeeded();
  // Recharts/ResponsiveContainer needs time to measure + paint the SVGs.
  await settle(page, 2500);
  assert(await growth.isVisible(), "MILESTONE 6: growth chart <figure> is visible");
  assert(
    (await growth.locator("svg").count()) > 0,
    "MILESTONE 6: growth chart rendered a Recharts <svg>",
  );
  await pause(page, 2000); // PAUSE on the forest growth line
  await watering.scrollIntoViewIfNeeded();
  await settle(page, 2500);
  assert(
    await watering.isVisible(),
    "MILESTONE 6: watering chart <figure> is visible",
  );
  assert(
    (await watering.locator("svg").count()) > 0,
    "MILESTONE 6: watering chart rendered a Recharts <svg>",
  );
  await pause(page, 2200); // PAUSE on the clay watering chart
  await beat(page);

  // STEP 7 — End back on the home for a clean closing frame.
  await page.goto(BASE_URL);
  await settle(page);
  await beat(page);
}

// ---- server lifecycle (skipped when BASE_URL points at an external server) ----
async function ensureReachable(url) {
  for (let i = 0; i < 180; i++) {
    try {
      const res = await fetch(url);
      if (res.ok || res.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`app not reachable at ${url} — server did not come up in time`);
}

function run(cmd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      env: { ...process.env, ...env },
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`)),
    );
  });
}

async function startOwnServer() {
  console.log(`[full-demo] seeding ${DEMO_DB_URL} …`);
  await run("node", ["--import", "tsx", "scripts/seed-demo-db.mjs"], {
    DEMO_DATABASE_URL: DEMO_DB_URL,
  });

  if (process.env.SKIP_BUILD !== "1") {
    console.log("[full-demo] building …");
    await run("npm", ["run", "build"], { DATABASE_URL: DEMO_DB_URL });
  } else {
    console.log("[full-demo] SKIP_BUILD=1 — reusing existing .next");
  }

  console.log(`[full-demo] starting next on :${PORT} (DB=${DEMO_DB_URL}) …`);
  const server = spawn("npm", ["run", "start", "--", "-p", PORT], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: DEMO_DB_URL, PORT },
  });
  await ensureReachable(BASE_URL);
  return server;
}

async function main() {
  let server = null;
  if (!EXTERNAL_BASE_URL) {
    server = await startOwnServer();
  } else {
    console.log(`[full-demo] driving external server at ${BASE_URL}`);
    await ensureReachable(BASE_URL);
  }

  // Only clear OUR own subdirectory — never the sibling per-capability clips or
  // manifest in docs/qa/demo-recordings/.
  if (existsSync(OUT_DIR)) await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch(); // headless by default
  // ONE context, ONE page, recordVideo at the context level — so the entire
  // journey spans a single continuous video file.
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: OUT_DIR, size: VIEWPORT },
  });
  const page = await context.newPage();

  const startedAt = Date.now();
  let error = null;
  try {
    await driveJourney(page);
  } catch (e) {
    error = e;
  } finally {
    const video = page.video();
    // Closing the page+context flushes the video to disk under a hash name.
    await page.close().catch(() => {});
    await context.close().catch(() => {});
    let producedPath = null;
    if (video) producedPath = await video.path().catch(() => null);
    await browser.close().catch(() => {});
    if (server) server.kill("SIGTERM");

    // Rename the produced (hash-named) video to the stable final name, then
    // remove any stray intermediate .webm files in our subdir.
    if (producedPath && existsSync(producedPath)) {
      await rm(FINAL_VIDEO, { force: true }).catch(() => {});
      await rename(producedPath, FINAL_VIDEO).catch(async () => {
        // Cross-device fallback would need a copy; same dir, so rename suffices.
      });
    }
    // Sweep any leftover hash-named webms (e.g. from a prior aborted run).
    const entries = await readdir(OUT_DIR).catch(() => []);
    for (const name of entries) {
      if (name.endsWith(".webm") && name !== "poliaivko-full-demo.webm") {
        await rm(join(OUT_DIR, name), { force: true }).catch(() => {});
      }
    }

    const elapsedS = ((Date.now() - startedAt) / 1000).toFixed(1);
    if (error) {
      console.error(
        `\n[full-demo] FAILED during the journey: ${error.message ?? error}`,
      );
      console.error(
        `[full-demo] a partial video may exist at ${FINAL_VIDEO} for debugging.`,
      );
      process.exit(1);
    }
    const size = existsSync(FINAL_VIDEO) ? statSync(FINAL_VIDEO).size : 0;
    assert(size > 0, "final video was written and is non-empty");
    console.log(
      `\n[full-demo] OK — continuous journey recorded through all 7 steps.`,
    );
    console.log(`[full-demo] video : ${FINAL_VIDEO}`);
    console.log(`[full-demo] size  : ${(size / 1024).toFixed(1)} KiB`);
    console.log(`[full-demo] driven: ~${elapsedS}s of paced flow`);
    process.exit(0);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
