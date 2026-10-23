/**
 * test-companion.mjs — headless UI assertions for the Cute Labubo companion.
 *
 * Verifies the full click flow: the mascot is on the page, clicking it opens
 * the panel, the panel renders the *live* project process from /api/project,
 * refresh re-fetches, and Esc closes it. No console errors allowed.
 *
 *   node test-companion.mjs
 */

import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

/**
 * Resolve playwright-core from an explicit file location (optional).
 * The app itself has zero dependencies — this is only for the test harness.
 */
async function loadChromium() {
  const pick = (m) => m?.chromium ?? m?.default?.chromium ?? m?.["module.exports"]?.chromium;
  try {
    const c = pick(await import("playwright-core"));
    if (c) return c;
  } catch { /* fall through to explicit paths */ }
  const candidates = [
    process.env.PLAYWRIGHT_CORE_PATH,
    "C:/Users/Sapna/AppData/Roaming/npm/node_modules/rea-agents/node_modules/playwright-core/index.js",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const chromium = pick(await import(pathToFileURL(c).href));
      if (chromium) return chromium;
    } catch { /* try next */ }
  }
  throw new Error(
    "playwright-core not found. Run `npm i -D playwright-core` or set PLAYWRIGHT_CORE_PATH.",
  );
}

const chromium = await loadChromium();

const BASE = process.env.BASE_URL || "http://127.0.0.1:4173";
const EXE =
  process.env.CHROME_PATH ||
  ["C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
   "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"]
    .find((p) => existsSync(p)) ||
  undefined;

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, extra = "") {
  if (condition) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    fail++;
    failures.push(name + (extra ? ` — ${extra}` : ""));
    console.log(`  \x1b[31m✗\x1b[0m ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

const toCamel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

try {
  console.log("\n▶ loading the app");
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("#labuboBtnArt svg", { timeout: 5000 });
  await page.waitForSelector("#phaseGrid .phase-card", { timeout: 5000 });

  check("page title includes live percent", /67%/.test(await page.title()), await page.title());
  check("companion button visible in corner", await page.isVisible("#labuboBtn"));
  check("companion button shows the mascot SVG", (await page.locator("#labuboBtnArt svg").count()) === 1);
  check("hero mascot rendered", (await page.locator("#mascotFloat svg").count()) === 1);
  const heroEar = await page.locator("#mascotFloat .lb-ear-l").count();
  check("mascot has ears (labubo silhouette)", heroEar === 1);
  check("mascot has fangs", (await page.locator("#mascotFloat .lb-fang").count()) === 2);
  check("phase cards rendered from API", (await page.locator("#phaseGrid .phase-card").count()) === 5);

  const api = await page.evaluate(() => fetch("/api/project").then((r) => r.json()));
  check("API reports 15 steps", api.stats.total === 15, String(api.stats.total));
  check("API percent matches 67", api.stats.percent === 67, String(api.stats.percent));

  console.log("\n▶ panel starts closed");
  check("panel hidden before click", await page.isHidden("#labuboPanel"));
  check("aria-expanded is false", (await page.getAttribute("#labuboBtn", "aria-expanded")) === "false");

  console.log("\n▶ clicking the Cute Labubo");
  await page.click("#labuboBtn");
  await page.waitForSelector("#labuboPanel.is-open", { timeout: 5000 });
  await page.waitForSelector("#labuboBody .phase-list", { timeout: 5000 });

  check("panel is open", await page.isVisible("#labuboPanel"));
  check("aria-expanded is true", (await page.getAttribute("#labuboBtn", "aria-expanded")) === "true");
  check("aria-modal dialog role", (await page.getAttribute("#labuboPanel", "role")) === "dialog");
  check("backdrop shown", await page.isVisible("#labuboBackdrop"));

  const phaseCount = await page.locator("#labuboBody .phase").count();
  check("all 5 phases shown in panel", phaseCount === 5, String(phaseCount));

  const stepCount = await page.locator("#labuboBody .step").count();
  check("all 15 steps shown in panel", stepCount === 15, String(stepCount));

  check("done steps marked", (await page.locator("#labuboBody .step.is-done").count()) === 10);
  check("active step marked", (await page.locator("#labuboBody .step.is-active").count()) === 1);

  const activeTitle = (await page.locator("#labuboBody .step.is-active .step-title").innerText()).trim();
  check("active step is the API's current step", activeTitle === api.current.step, `${activeTitle} vs ${api.current.step}`);

  const overall = (await page.locator("#panelOverall").innerText()).trim();
  check("panel overall percent rendered", overall.includes("67"), overall);

  const speech = (await page.locator("#panelSpeechText").innerText()).trim();
  check("Labubo says something about the project", speech.length > 10, speech);

  const headPhase = (await page.locator(".headinfo-meta .phase-chip").innerText()).trim();
  check("panel names the current phase", headPhase.includes(api.current.phase), headPhase);

  console.log("\n▶ live update: edit project-status.json and refresh");
  // flip the active step to done via the API-visible source file, then press ↻
  const { readFile, writeFile } = await import("node:fs/promises");
  const file = new URL("./project-status.json", import.meta.url);
  const original = await readFile(file, "utf8");
  try {
    const data = JSON.parse(original);
    const verify = data.phases.find((p) => p.title === "Verify");
    verify.steps[0].status = "done";
    verify.steps[1].status = "active";
    await writeFile(file, JSON.stringify(data, null, 2));
    await page.click("#labuboRefresh");
    await page.waitForTimeout(1400);
    const newActive = (await page.locator("#labuboBody .step.is-active .step-title").innerText()).trim();
    check("panel picked up the edited step", newActive === "Click the Cute Labubo", newActive);
    check("done count updated to 11", (await page.locator("#labuboBody .step.is-done").count()) === 11);
    await page.waitForTimeout(800);
    const newOverall = (await page.locator("#panelOverall").innerText()).trim();
    check("overall percent updated to 73%", newOverall.includes("73"), newOverall);
  } finally {
    await writeFile(file, original);
  }

  console.log("\n▶ closing");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  check("Esc closes the panel", await page.isHidden("#labuboPanel"));
  check("aria-expanded back to false", (await page.getAttribute("#labuboBtn", "aria-expanded")) === "false");

  await page.click("#labuboBtn");
  await page.waitForSelector("#labuboPanel.is-open");
  await page.click("#labuboClose");
  await page.waitForTimeout(500);
  check("close button closes the panel", await page.isHidden("#labuboPanel"));

  console.log("\n▶ other entry points + mobile layout");
  await page.click("#openCompanionHero");
  await page.waitForSelector("#labuboPanel.is-open");
  check("hero CTA opens the companion", await page.isVisible("#labuboPanel"));
  await page.click("#labuboClose");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const btnBox = await page.locator("#labuboBtn").boundingBox();
  check("companion button fits on mobile", btnBox && btnBox.x + btnBox.width <= 390 && btnBox.y + btnBox.height <= 844,
    JSON.stringify(btnBox));
  await page.click("#labuboBtn");
  await page.waitForSelector("#labuboPanel.is-open");
  const panelBox = await page.locator("#labuboPanel").boundingBox();
  check("panel fits inside mobile viewport", panelBox && panelBox.x >= 0 && panelBox.x + panelBox.width <= 391,
    JSON.stringify(panelBox));

  check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
} finally {
  await browser.close();
}

console.log(`\n${fail === 0 ? "\x1b[32m" : "\x1b[31m"}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) { console.log(failures.map((f) => " - " + f).join("\n")); process.exit(1); }
