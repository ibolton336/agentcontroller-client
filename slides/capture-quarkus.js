/* Capture stills + webm clips of the tackle2-ui (:9000) for the Quarkus workload demo.
 * Usage:
 *   node capture-quarkus.js shot <urlOrPath> <out.png> [waitMs]
 *   node capture-quarkus.js clip <urlOrPath> <out.webm> <seconds> [reloadHalfway]
 * Paths starting with "/" are served from http://localhost:9000 (hash-less router).
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:9000";
const url = (p) => (p.startsWith("http") ? p : BASE + p);

async function main() {
  const [mode, target, out, a4, a5] = process.argv.slice(2);
  if (!mode || !target || !out) {
    console.error("usage: shot <url> <out.png> [waitMs] | clip <url> <out.webm> <seconds> [reload]");
    process.exit(2);
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const browser = await chromium.launch();

  if (mode === "shot") {
    const waitMs = Number(a4 || 3500);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(url(target), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(waitMs);
    await page.screenshot({ path: out });
    console.log("shot ->", out);
  } else if (mode === "clip") {
    const seconds = Number(a4 || 12);
    const vidDir = out + ".tmpdir";
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordVideo: { dir: vidDir, size: { width: 1280, height: 800 } },
    });
    const page = await ctx.newPage();
    await page.goto(url(target), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    if (a5 === "reload") {
      await page.waitForTimeout((seconds * 1000) / 2);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForTimeout((seconds * 1000) / 2);
    } else {
      await page.waitForTimeout(seconds * 1000);
    }
    await ctx.close(); // flushes video
    const vids = fs.readdirSync(vidDir).filter((f) => f.endsWith(".webm"));
    if (!vids.length) throw new Error("no video produced");
    fs.renameSync(path.join(vidDir, vids[0]), out);
    fs.rmSync(vidDir, { recursive: true, force: true });
    console.log("clip ->", out);
  } else {
    throw new Error("unknown mode " + mode);
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
