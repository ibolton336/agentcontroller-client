/* Drive the :5199 SPA with Playwright and record webm clips for the deck GIFs.
 * Usage: node record.js <clip1|clip2|clip4|clip6>
 * Selector map from ui/src (no router, no testids — role/label/text only).
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const UI = "http://127.0.0.1:5199";
const OUT = path.join(__dirname, "videos");
const RUNFILE = path.join(__dirname, "runname.txt");
fs.mkdirSync(OUT, { recursive: true });

// Fake cursor so clicks are legible in the GIF (Playwright video has no pointer).
const CURSOR_JS = `
(() => {
  if (window.__pwCursor) return;
  window.__pwCursor = true;
  const d = document.createElement('div');
  d.id = 'pw-cursor';
  Object.assign(d.style, {
    position: 'fixed', top: '-60px', left: '-60px', width: '18px', height: '18px',
    borderRadius: '50%', background: 'rgba(79,70,229,0.85)',
    border: '2.5px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.4)',
    pointerEvents: 'none', zIndex: '2147483647',
    transform: 'translate(-50%,-50%)', transition: 'width .12s,height .12s,background .12s',
  });
  const add = () => document.body && document.body.appendChild(d);
  document.body ? add() : document.addEventListener('DOMContentLoaded', add);
  document.addEventListener('mousemove', (e) => {
    d.style.left = e.clientX + 'px'; d.style.top = e.clientY + 'px';
  }, true);
  document.addEventListener('mousedown', () => {
    d.style.width = '26px'; d.style.height = '26px'; d.style.background = 'rgba(34,211,238,0.9)';
  }, true);
  document.addEventListener('mouseup', () => {
    d.style.width = '18px'; d.style.height = '18px'; d.style.background = 'rgba(79,70,229,0.85)';
  }, true);
})();`;

const pause = (page, ms) => page.waitForTimeout(ms);

async function withPage(name, fn) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: OUT, size: { width: 1280, height: 800 } },
  });
  const page = await context.newPage();
  await page.addInitScript(CURSOR_JS);
  let err = null;
  try {
    await fn(page);
  } catch (e) {
    err = e;
    try { await page.screenshot({ path: path.join(OUT, `${name}-FAIL.png`) }); } catch {}
  }
  const video = page.video();
  await context.close();
  const vpath = await video.path();
  fs.renameSync(vpath, path.join(OUT, `${name}.webm`));
  await browser.close();
  if (err) throw err;
  console.log(`${name}.webm recorded`);
}

async function openRun(page, runName) {
  await page.goto(UI);
  await page.locator("table[aria-label='Agent runs'], [role='grid'][aria-label='Agent runs']").first().waitFor({ timeout: 15000 });
  await pause(page, 900);
  await page.getByRole("button", { name: runName, exact: true }).click();
  // waiting -> connecting -> connected (green label in .chat-status)
  await page.locator(".chat-status").getByText("connected", { exact: true })
    .waitFor({ timeout: 90000 });
  await pause(page, 1000);
}

async function send(page, text) {
  const box = page.getByLabel("Message to the agent");
  await box.click();
  await box.pressSequentially(text, { delay: 14 });
  await pause(page, 500);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}

const turnEnded = (page, nth) =>
  page.locator(".chat-meta", { hasText: "turn ended" }).nth(nth)
    .waitFor({ timeout: 150000 });

// ── clip1: create a mock run, watch it go Running, chat connects ──
async function clip1(page) {
  await page.goto(UI);
  await page.locator("table[aria-label='Agent runs'], [role='grid'][aria-label='Agent runs']").first().waitFor({ timeout: 15000 });
  await pause(page, 1200);
  await page.getByRole("button", { name: "Create run" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create run" });
  await dialog.waitFor();
  // agents load async; make sure the mock agent is selected
  const agentSel = page.locator("#create-agent");
  await agentSel.waitFor();
  await page.waitForFunction(
    () => document.querySelectorAll("#create-agent option").length > 0);
  await pause(page, 700);
  await agentSel.selectOption({ label: "migration-analyzer" });
  await pause(page, 900);
  // application select appears once the agent's platform params are known
  const appSel = page.locator("#create-application");
  await appSel.waitFor({ timeout: 15000 });
  await page.waitForFunction(
    () => document.querySelectorAll("#create-application option").length > 1);
  await appSel.selectOption({ index: 1 }); // first real app (Coolstore)
  // the whole point of the beat: show the platform-resolved params
  const resolved = page.locator(".resolved-params");
  await resolved.waitFor({ timeout: 10000 });
  await resolved.scrollIntoViewIfNeeded();
  await pause(page, 2200);
  const instr = page.locator("#create-instructions");
  await instr.click();
  await instr.pressSequentially("Assess this application for cloud readiness.", { delay: 14 });
  await pause(page, 700);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  // detail view: wait through waiting/connecting to connected
  await page.locator(".chat-status").getByText("connected", { exact: true })
    .waitFor({ timeout: 120000 });
  // capture the created run's name for the later clips
  const heading = await page.locator("h1").first().textContent();
  const m = (heading || "").trim().match(/[a-z0-9-]+/i);
  if (m) fs.writeFileSync(RUNFILE, m[0]);
  await pause(page, 1800);
}

// ── clip2: TEST_PERMISSION → diff → Reject → again → Allow ──
async function clip2(page) {
  const runName = fs.existsSync(RUNFILE) ? fs.readFileSync(RUNFILE, "utf8").trim() : "ui-pzn2m";
  await openRun(page, runName);
  await send(page, "Migrate javax imports to jakarta. TEST_PERMISSION");
  const perm = page.locator(".chat-permission");
  await perm.first().waitFor({ timeout: 30000 });
  await pause(page, 2600); // let the viewer read the diff
  await page.locator(".chat-permission-actions").last()
    .getByRole("button", { name: "Reject" }).click();
  await page.getByText("Permission outcome").first().waitFor({ timeout: 15000 });
  await turnEnded(page, 0);
  await pause(page, 1400);
  await send(page, "Proceed with the migration. TEST_PERMISSION");
  await page.locator(".chat-permission-actions").last()
    .getByRole("button", { name: "Allow" }).waitFor({ timeout: 30000 });
  await pause(page, 1600);
  await page.locator(".chat-permission-actions").last()
    .getByRole("button", { name: "Allow" }).click();
  await turnEnded(page, 1);
  await pause(page, 1800);
}

// ── clip6: build history → connection drops → Reconnect → session/load replay ──
// (TEST_DROP's pod-side socket destroy is swallowed by the port-forward tunnel —
// see the filed shim finding — so we sever the browser-side WS instead; the
// UI-visible story is identical: Disconnected → Reconnect → replay.)
const WS_TAP = `
  window.__ws = [];
  window.WebSocket = class extends WebSocket {
    constructor(...a) { super(...a); window.__ws.push(this); }
  };`;
async function clip6(page) {
  const runName = fs.existsSync(RUNFILE) ? fs.readFileSync(RUNFILE, "utf8").trim() : "ui-pzn2m";
  await page.addInitScript(WS_TAP);
  await openRun(page, runName);
  await send(page, "Scan the workspace and summarize what you find.");
  await turnEnded(page, 0);
  await pause(page, 1400);
  // sever only the ACP WebSocket (closing Vite's HMR socket reloads the page)
  await page.evaluate(() =>
    window.__ws.filter((s) => s.url.includes("/acp")).forEach((s) => s.close()));
  await page.getByText("Disconnected from the agent").waitFor({ timeout: 15000 });
  await pause(page, 2000); // let the alert register
  await page.getByRole("button", { name: "Reconnect" }).click();
  // transcript clears, session/load replays the full history
  await page.locator(".chat-status").getByText("connected", { exact: true })
    .waitFor({ timeout: 60000 });
  await page.getByText("Scan the workspace and summarize what you find.")
    .waitFor({ timeout: 30000 });
  await pause(page, 2400);
}

// ── clip4: goose + Bedrock grounded answer ──
async function clip4(page) {
  await openRun(page, process.env.GOOSE_RUN || "ui-cdkcl");
  await send(page,
    "What build system does this project use? Name two files at the repository root that support your answer.");
  await turnEnded(page, 0);
  // expand the first tool call so the GIF shows the real command
  const tool = page.locator(".chat-tool button").first();
  if (await tool.count()) {
    await tool.scrollIntoViewIfNeeded();
    await tool.click();
    await pause(page, 2000);
  }
  await pause(page, 1800);
}

const clips = { clip1, clip2, clip4, clip6 };
const which = process.argv[2];
if (!clips[which]) {
  console.error("usage: node record.js <clip1|clip2|clip4|clip6>");
  process.exit(2);
}
withPage(which, clips[which]).catch((e) => { console.error(e.message); process.exit(1); });
