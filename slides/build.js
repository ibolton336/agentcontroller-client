/* agentic-controller PR #4 — demo + upstream findings deck (Konveyor audience) */
const fs = require("fs");
const path = require("path");
const pptx = require("pptxgenjs");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const sharp = require("sharp");
const FA = require("react-icons/fa");

// ---------- palette ----------
const INK = "0E1230", INK2 = "1B1F44", INDIGO = "4F46E5", VIOLET = "7C3AED";
const CYAN = "22D3EE", LIGHT = "FFFFFF", TINT = "F4F5FB", TINT2 = "EBEDFA";
const BODY = "1E2138", MUTED = "5B6079", HAIR = "DCDFF0";
const GREEN = "16A34A", AMBER = "B45309", RED = "DC2626";
const F = "Calibri", MONO = "Courier New";

const pres = new pptx();
pres.defineLayout({ name: "W", width: 10, height: 5.625 });
pres.layout = "W";
pres.author = "agentcontroller-client";
pres.title = "agentic-controller PR #4 — demo + upstream findings";
const W = 10, H = 5.625, M = 0.55;
const shadow = () => ({ type: "outer", color: "1B1F44", blur: 9, offset: 3, angle: 90, opacity: 0.16 });

// ---------- icon rasterization ----------
async function icon(Comp, color, size = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(
    React.createElement(Comp, { color, size: String(size) }));
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return "image/png;base64," + png.toString("base64");
}
const IC = {};
async function loadIcons() {
  const spec = {
    users: [FA.FaUsers, LIGHT], robot: [FA.FaRobot, LIGHT],
    contract: [FA.FaFileContract, LIGHT], clip: [FA.FaClipboardCheck, LIGHT],
    browser: [FA.FaWindowMaximize, INDIGO], code: [FA.FaCode, INDIGO],
    routeW: [FA.FaRandom, LIGHT], wheel: [FA.FaDharmachakra, INDIGO],
    cube: [FA.FaCube, VIOLET], filmW: [FA.FaFilm, LIGHT], robotD: [FA.FaRobot, INDIGO],
    shield: [FA.FaShieldAlt, VIOLET], ban: [FA.FaBan, AMBER],
    unlink: [FA.FaUnlink, RED], history: [FA.FaHistory, INDIGO],
    key: [FA.FaKey, INDIGO], net: [FA.FaNetworkWired, INDIGO], lock: [FA.FaLock, INDIGO],
    tag: [FA.FaTag, INDIGO], book: [FA.FaBook, INDIGO], layers: [FA.FaLayerGroup, INDIGO],
    arrow: [FA.FaArrowRight, CYAN], bolt: [FA.FaBolt, CYAN], check: [FA.FaCheckCircle, GREEN],
    plug: [FA.FaPlug, INDIGO], wifi: [FA.FaExchangeAlt, VIOLET],
  };
  for (const [k, [c, col]] of Object.entries(spec)) IC[k] = await icon(c, "#" + col);
}

// ---------- helpers ----------
function footer(s, n, dark) {
  const col = dark ? "8A8FB8" : MUTED;
  s.addText("Konveyor · agentic-controller PR #4 — demo + upstream findings", {
    x: M, y: H - 0.36, w: 7, h: 0.25, fontFace: F, fontSize: 8, color: col, align: "left", margin: 0 });
  s.addText(String(n), { x: W - M - 0.6, y: H - 0.36, w: 0.6, h: 0.25, fontFace: F, fontSize: 8, color: col, align: "right", margin: 0 });
}
function iconCircle(s, key, cx, cy, d, fill) {
  s.addShape(pres.shapes.OVAL, { x: cx, y: cy, w: d, h: d, fill: { color: fill }, line: { type: "none" } });
  const p = d * 0.28;
  s.addImage({ data: IC[key], x: cx + p, y: cy + p, w: d - 2 * p, h: d - 2 * p });
}
function kicker(s, text, x, y, color) {
  s.addText(text.toUpperCase(), { x, y, w: 8, h: 0.3, fontFace: F, fontSize: 11.5, bold: true,
    color: color || VIOLET, charSpacing: 2.5, align: "left", margin: 0 });
}
function title(s, text, x, y, color, size) {
  s.addText(text, { x, y, w: W - x - M, h: 0.75, fontFace: F, fontSize: size || 30, bold: true,
    color: color || BODY, align: "left", margin: 0 });
}

// ---------- 1. TITLE ----------
function slideTitle() {
  const s = pres.addSlide(); s.background = { color: INK };
  s.addShape(pres.shapes.OVAL, { x: 6.6, y: -1.7, w: 5.2, h: 5.2, fill: { color: INDIGO, transparency: 82 }, line: { type: "none" } });
  s.addShape(pres.shapes.OVAL, { x: 8.1, y: 2.6, w: 4.2, h: 4.2, fill: { color: VIOLET, transparency: 84 }, line: { type: "none" } });
  s.addShape(pres.shapes.OVAL, { x: M, y: 0.9, w: 0.16, h: 0.16, fill: { color: CYAN }, line: { type: "none" } });
  s.addText("RUNNING PR #4 FOR REAL", { x: M + 0.28, y: 0.83, w: 7, h: 0.3, fontFace: F, fontSize: 12.5, bold: true, color: CYAN, charSpacing: 3, margin: 0 });
  s.addText("Two clients, one contract", { x: M, y: 1.55, w: 8.6, h: 1.4, fontFace: F, fontSize: 52, bold: true, color: LIGHT, margin: 0, lineSpacingMultiple: 0.95 });
  s.addText("A live demo of konveyor/agentic-controller PR #4 — plus the upstream findings from running it for real on minikube.", {
    x: M, y: 3.05, w: 8.1, h: 0.8, fontFace: F, fontSize: 15.5, color: "C7CBEA", margin: 0, lineSpacingMultiple: 1.1 });
  const chips = ["minikube", "Agent Sandbox v0.5.0", "agentic-controller PR #4", "goose 1.39 + Bedrock"];
  let cx = M;
  chips.forEach((c) => {
    const w = 0.34 + c.length * 0.088;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: cx, y: 4.35, w, h: 0.42, rectRadius: 0.21, fill: { color: INK2 }, line: { color: "3A3F70", width: 1 } });
    s.addText(c, { x: cx, y: 4.35, w, h: 0.42, fontFace: F, fontSize: 10.5, color: "D7DAF4", align: "center", valign: "middle", margin: 0 });
    cx += w + 0.18;
  });
  footer(s, 1, true);
  s.addNotes("Framing: this is not a mock of the platform — it's PR #4 doing real work, driven by two independent clients over one shared contract. The point of the talk is (a) it works and (b) here are small, pre-merge asks that make it work for everyone.");
}

// ---------- 2. TL;DR ----------
function slideTldr() {
  const s = pres.addSlide(); s.background = { color: INK };
  kicker(s, "the takeaway", M, 0.55, CYAN);
  s.addText([
    { text: "The contract is ", options: { color: LIGHT } },
    { text: "verified", options: { color: CYAN } },
    { text: ", not aspirational.", options: { color: LIGHT } },
  ], { x: M, y: 0.95, w: 9, h: 0.9, fontFace: F, fontSize: 34, bold: true, margin: 0 });
  s.addText("Every fact below was proven against the live controller and encoded in the shared client core — same CR, any client, any agent.", {
    x: M, y: 1.85, w: 8.9, h: 0.55, fontFace: F, fontSize: 14, color: "B9BEE4", margin: 0, lineSpacingMultiple: 1.05 });
  const stats = [
    ["2", "clients", "VSCode extension + browser SPA", "users"],
    ["2", "agents", "deterministic mock + goose on Bedrock", "robot"],
    ["1", "contract", "one AgentRun / ACP surface, shared core", "contract"],
    ["4", "upstream asks", "all pre-merge · none block PR #4", "clip"],
  ];
  const cw = (W - 2 * M - 3 * 0.28) / 4, y = 2.75, ch = 2.05;
  stats.forEach((st, i) => {
    const x = M + i * (cw + 0.28);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, rectRadius: 0.1, fill: { color: INK2 }, line: { color: "343A6B", width: 1 } });
    iconCircle(s, st[3], x + cw / 2 - 0.3, y + 0.24, 0.6, INDIGO);
    s.addText(st[0], { x: x + 0.02, y: y + 0.62, w: cw - 0.04, h: 0.95, fontFace: F, fontSize: 54, bold: true, color: CYAN, align: "center", valign: "middle", margin: 0 });
    s.addText(st[1], { x: x + 0.1, y: y + 1.42, w: cw - 0.2, h: 0.3, fontFace: F, fontSize: 14.5, bold: true, color: LIGHT, align: "center", margin: 0 });
    s.addText(st[2], { x: x + 0.14, y: y + 1.68, w: cw - 0.28, h: 0.34, fontFace: F, fontSize: 9.5, color: "9EA3CC", align: "center", margin: 0, lineSpacingMultiple: 0.95 });
  });
  footer(s, 2, true);
  s.addNotes("Land the four numbers, then move fast. The rest of the deck is evidence for '1 contract' and detail on the '4 asks'.");
}

// ---------- 3. THE STACK ----------
function slideStack() {
  const s = pres.addSlide(); s.background = { color: LIGHT };
  kicker(s, "the stack", M, 0.5);
  title(s, "One contract, wired end to end", M, 0.82);
  s.addText("No simulator anywhere: the reconciler is the real controller, the sandbox is Agent Sandbox v0.5.0.", {
    x: M, y: 1.5, w: 9, h: 0.35, fontFace: F, fontSize: 12.5, color: MUTED, margin: 0 });

  const colY = 2.05, colH = 2.9;
  // clients column
  const clX = M, clW = 2.35;
  s.addText("CLIENTS", { x: clX, y: colY - 0.02, w: clW, h: 0.25, fontFace: F, fontSize: 9.5, bold: true, color: MUTED, charSpacing: 2, align: "center", margin: 0 });
  const cardClients = [["browser", "Browser SPA", "PatternFly · :5199"], ["code", "VSCode extension", "feature/cluster-agent"]];
  cardClients.forEach((c, i) => {
    const y = colY + 0.32 + i * 1.28;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: clX, y, w: clW, h: 1.08, rectRadius: 0.08, fill: { color: LIGHT }, line: { color: HAIR, width: 1 }, shadow: shadow() });
    iconCircle(s, c[0], clX + 0.16, y + 0.3, 0.48, TINT2);
    s.addText(c[1], { x: clX + 0.74, y: y + 0.2, w: clW - 0.85, h: 0.3, fontFace: F, fontSize: 13, bold: true, color: BODY, margin: 0 });
    s.addText(c[2], { x: clX + 0.74, y: y + 0.52, w: clW - 0.85, h: 0.3, fontFace: F, fontSize: 9.5, color: MUTED, margin: 0 });
  });

  // shim column (the seat)
  const shX = clX + clW + 0.55, shW = 2.15;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: shX, y: colY + 0.14, w: shW, h: colH - 0.14, rectRadius: 0.1, fill: { color: "F3F1FE" }, line: { color: VIOLET, width: 1.25 }, shadow: shadow() });
  iconCircle(s, "routeW", shX + shW / 2 - 0.32, colY + 0.38, 0.64, VIOLET);
  s.addText("hub-shim", { x: shX, y: colY + 1.1, w: shW, h: 0.32, fontFace: F, fontSize: 15, bold: true, color: VIOLET, align: "center", margin: 0 });
  s.addText("the Hub-proxy seat", { x: shX, y: colY + 1.42, w: shW, h: 0.28, fontFace: F, fontSize: 11, italic: true, color: "6D28D9", align: "center", margin: 0 });
  s.addText([
    { text: "REST + WS ", options: {} }, { text: "/acp", options: { fontFace: MONO } },
    { text: "  ·  :7080", options: {} },
  ], { x: shX + 0.1, y: colY + 1.78, w: shW - 0.2, h: 0.3, fontFace: F, fontSize: 10, color: BODY, align: "center", margin: 0 });
  s.addText([{ text: "X-Secret-Key", options: { fontFace: MONO, bold: true } }, { text: " injected", options: {} }], {
    x: shX + 0.12, y: colY + 2.12, w: shW - 0.24, h: 0.55, fontFace: F, fontSize: 10, color: MUTED, align: "center", margin: 0, lineSpacingMultiple: 1.0 });

  // cluster column
  const kX = shX + shW + 0.55, kW = W - M - (shX + shW + 0.55);
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: kX, y: colY + 0.14, w: kW, h: colH - 0.14, rectRadius: 0.1, fill: { color: TINT }, line: { color: HAIR, width: 1 }, shadow: shadow() });
  iconCircle(s, "wheel", kX + 0.18, colY + 0.3, 0.46, LIGHT);
  s.addText("minikube", { x: kX + 0.72, y: colY + 0.34, w: kW - 0.8, h: 0.34, fontFace: F, fontSize: 14, bold: true, color: BODY, margin: 0 });
  const inner = [
    ["agentic-controller PR #4", "validates Agent/provider · creates Sandbox CR"],
    ["Agent Sandbox v0.5.0", "spins the pod · headless portless Service"],
  ];
  inner.forEach((c, i) => {
    const y = colY + 0.92 + i * 0.62;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: kX + 0.16, y, w: kW - 0.32, h: 0.52, rectRadius: 0.06, fill: { color: LIGHT }, line: { color: HAIR, width: 1 } });
    s.addText(c[0], { x: kX + 0.3, y: y + 0.06, w: kW - 0.5, h: 0.24, fontFace: F, fontSize: 10.5, bold: true, color: BODY, margin: 0 });
    s.addText(c[1], { x: kX + 0.3, y: y + 0.28, w: kW - 0.5, h: 0.22, fontFace: F, fontSize: 8.5, color: MUTED, margin: 0 });
  });
  const py = colY + 2.2;
  s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: kX + 0.16, y: py, w: kW - 0.32, h: 0.56, rectRadius: 0.06, fill: { color: INK }, line: { type: "none" } });
  iconCircle(s, "cube", kX + 0.3, py + 0.12, 0.34, INK2);
  s.addText([
    { text: "sandbox pod", options: { bold: true, color: LIGHT } },
    { text: "   ACP :4000", options: { fontFace: MONO, color: CYAN } },
    { text: "   harness: mock | goose", options: { color: "AEB3DD" } },
  ], { x: kX + 0.72, y: py, w: kW - 0.85, h: 0.56, fontFace: F, fontSize: 9.5, valign: "middle", margin: 0 });

  // arrows between columns
  [[clX + clW + 0.06, shX - 0.06], [shX + shW + 0.06, kX - 0.06]].forEach(([x1, x2]) => {
    s.addShape(pres.shapes.LINE, { x: x1, y: colY + 1.55, w: x2 - x1, h: 0, line: { color: VIOLET, width: 2, endArrowType: "triangle" } });
  });
  footer(s, 3, false);
  s.addNotes("Read left to right: two clients, the shim seat, the real cluster. Only the middle lane (hub-shim) is a stand-in — everything else is the real controller + Agent Sandbox. Foreshadow: that middle seat is what the real Hub passthrough proxy replaces later.");
}

// ---------- 4. DEMO, AS RUN ----------
function slideRunningOrder() {
  const s = pres.addSlide(); s.background = { color: LIGHT };
  kicker(s, "the demo, as run", M, 0.5);
  title(s, "The order I presented it", M, 0.82);
  const steps = [
    ["1", "Create a run", "demo-up → mock AgentRun → Running", "browser"],
    ["2", "Permission diff", "ACP + TEST_PERMISSION in the browser", "shield"],
    ["3", "Attach in the IDE", "VSCode links + approves the same run", "code"],
    ["4", "Real model", "goose + Bedrock, grounded answer", "robotD"],
    ["5", "Pick a run", "VSCode selects between runs from a toast", "history"],
  ];
  const gap = 0.2, cw = (W - 2 * M - 4 * gap) / 5, y = 1.85, ch = 2.55;
  steps.forEach((st, i) => {
    const x = M + i * (cw + gap);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: ch, rectRadius: 0.09, fill: { color: TINT }, line: { color: HAIR, width: 1 }, shadow: shadow() });
    s.addShape(pres.shapes.OVAL, { x: x + cw / 2 - 0.28, y: y + 0.26, w: 0.56, h: 0.56, fill: { color: INDIGO }, line: { type: "none" } });
    s.addText(st[0], { x: x + cw / 2 - 0.28, y: y + 0.26, w: 0.56, h: 0.56, fontFace: F, fontSize: 22, bold: true, color: LIGHT, align: "center", valign: "middle", margin: 0 });
    iconCircle(s, st[3], x + cw / 2 - 0.24, y + 1.02, 0.48, TINT2);
    s.addText(st[1], { x: x + 0.1, y: y + 1.6, w: cw - 0.2, h: 0.34, fontFace: F, fontSize: 12.5, bold: true, color: BODY, align: "center", margin: 0 });
    s.addText(st[2], { x: x + 0.14, y: y + 1.95, w: cw - 0.28, h: 0.55, fontFace: F, fontSize: 9, color: MUTED, align: "center", margin: 0, lineSpacingMultiple: 0.95 });
    if (i < 4) s.addText("›", { x: x + cw - 0.02, y: y + ch / 2 - 0.25, w: gap + 0.04, h: 0.5, fontFace: F, fontSize: 20, bold: true, color: VIOLET, align: "center", valign: "middle", margin: 0 });
  });
  s.addText("One slide per beat follows — browser beats recorded live from the running stack; drop your VSCode captures into the two placeholders.", {
    x: M, y: 4.7, w: 9, h: 0.35, fontFace: F, fontSize: 12, italic: true, color: MUTED, margin: 0 });
  footer(s, 4, false);
  s.addNotes("This mirrors exactly how the demo was run live. Each following slide holds the GIF for one step.");
}

// ---------- GIF beat slides ----------
function slideGif(n, kickerText, ttl, gifFile, whatShows, bullets, badge) {
  const s = pres.addSlide(); s.background = { color: LIGHT };
  kicker(s, kickerText, M, 0.5);
  title(s, ttl, M, 0.82, BODY, 27);
  const gifPath = path.join(__dirname, "assets", gifFile);
  const embedded = fs.existsSync(gifPath);
  const gx = M, gy = 1.75, gh = 3.25;
  // recorded clips are 1280x800 (8:5) — keep aspect when embedding
  const gw = embedded ? gh * 1.6 : 5.75;
  if (embedded) {
    // real recording (animated in Slideshow on Microsoft 365)
    s.addImage({ path: gifPath, x: gx, y: gy, w: gw, h: gh });
    s.addShape(pres.shapes.RECTANGLE, {
      x: gx, y: gy, w: gw, h: gh,
      fill: { color: LIGHT, transparency: 100 }, line: { color: HAIR, width: 1.25 },
    });
  } else {
    // placeholder drop zone
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: gx, y: gy, w: gw, h: gh, rectRadius: 0.08, fill: { color: TINT }, line: { color: VIOLET, width: 1.5, dashType: "dash" } });
    iconCircle(s, "filmW", gx + gw / 2 - 0.42, gy + 0.75, 0.84, INDIGO);
    s.addText("REPLACE WITH GIF", { x: gx, y: gy + 1.72, w: gw, h: 0.3, fontFace: F, fontSize: 12, bold: true, color: VIOLET, charSpacing: 2, align: "center", margin: 0 });
    s.addText(whatShows, { x: gx + 0.5, y: gy + 2.05, w: gw - 1, h: 0.45, fontFace: F, fontSize: 10.5, color: MUTED, align: "center", margin: 0, lineSpacingMultiple: 1.0 });
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: gx + gw / 2 - 1.55, y: gy + gh - 0.55, w: 3.1, h: 0.34, rectRadius: 0.17, fill: { color: LIGHT }, line: { color: HAIR, width: 1 } });
    s.addText("assets/" + gifFile, { x: gx + gw / 2 - 1.55, y: gy + gh - 0.55, w: 3.1, h: 0.34, fontFace: MONO, fontSize: 10, color: INDIGO, align: "center", valign: "middle", margin: 0 });
  }
  // right: narration
  const tx = gx + gw + 0.45, tw = W - M - (gx + gw + 0.45);
  if (badge) {
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: tx, y: 1.75, w: 0.28 + badge.length * 0.098, h: 0.34, rectRadius: 0.17, fill: { color: TINT2 }, line: { type: "none" } });
    s.addText(badge, { x: tx, y: 1.75, w: 0.28 + badge.length * 0.098, h: 0.34, fontFace: MONO, fontSize: 10.5, bold: true, color: VIOLET, align: "center", valign: "middle", margin: 0 });
  }
  const by = badge ? 2.3 : 1.9;
  s.addText(bullets.map((b, i) => ({
    text: b, options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 9, color: BODY, fontSize: 13 },
  })), { x: tx, y: by, w: tw, h: 3.25 - (by - 1.75), fontFace: F, valign: "top", margin: 0, lineSpacingMultiple: 1.02 });
  footer(s, n, false);
  return s;
}

// ---------- 10. mock harness conformance ----------
function slideConformance() {
  const s = pres.addSlide(); s.background = { color: LIGHT };
  kicker(s, "why the mock matters", M, 0.5);
  title(s, "A deterministic conformance surface", M, 0.82);
  s.addText("Real ACP via the SDK, a fake agent — so we can drive the hard protocol edges on cue. No LLM, instant, free.", {
    x: M, y: 1.5, w: 9, h: 0.35, fontFace: F, fontSize: 12.5, color: MUTED, margin: 0 });
  const cards = [
    ["shield", "TEST_PERMISSION", "request_permission with real ACP diff blocks — javax→jakarta, rendered before approve", VIOLET],
    ["ban", "TEST_CANCEL", "streams until session/cancel arrives → stopReason: cancelled", AMBER],
    ["unlink", "TEST_DROP", "destroys sockets mid-turn — and caught a real gap: the shim's port-forward tunnel absorbs the drop (fix filed)", RED],
    ["history", "session/load", "full history replay — the architect→developer handoff, isolated (next slide, live)", INDIGO],
  ];
  const gap = 0.28, cw = (W - 2 * M - gap) / 2, chh = 1.32, y0 = 2.05;
  cards.forEach((c, i) => {
    const x = M + (i % 2) * (cw + gap), y = y0 + Math.floor(i / 2) * (chh + 0.24);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: chh, rectRadius: 0.09, fill: { color: TINT }, line: { color: HAIR, width: 1 }, shadow: shadow() });
    iconCircle(s, c[0], x + 0.22, y + 0.26, 0.56, LIGHT);
    s.addText(c[1], { x: x + 0.92, y: y + 0.22, w: cw - 1.05, h: 0.34, fontFace: MONO, fontSize: 14, bold: true, color: c[3], margin: 0 });
    s.addText(c[2], { x: x + 0.92, y: y + 0.58, w: cw - 1.1, h: 0.65, fontFace: F, fontSize: 10.5, color: BODY, margin: 0, lineSpacingMultiple: 1.0 });
  });
  footer(s, 10, false);
  s.addNotes("For upstream: this is a conformance harness you can keep — replace the image with the real one and nothing in the client changes. It's how we prove permission diffs, cancellation and reconnect without burning tokens. Bonus: recording the demo GIFs with it caught a real bridge bug — TEST_DROP's pod-side socket destroy never surfaces through the shim's port-forward tunnel, so the browser hangs instead of seeing a disconnect. Keepalive fix filed. That's the harness doing its job.");
}

// ---------- 11. shim = proposed Hub proxy seat ----------
function slideSeat() {
  const s = pres.addSlide(); s.background = { color: INK };
  kicker(s, "what changes later", M, 0.5, CYAN);
  title(s, "The shim is the Hub-proxy seat", M, 0.82, LIGHT);
  s.addText("Only one lane changes: browser clients ride the gateway seat. hub-shim occupies it today; the real Hub passthrough proxy replaces it. Its route table is the proposed spec (ADR 0004).", {
    x: M, y: 1.5, w: 9, h: 0.7, fontFace: F, fontSize: 13.5, color: "C4C9EC", margin: 0, lineSpacingMultiple: 1.1 });
  const pts = [
    ["Browsers can't set WS headers", "so X-Secret-Key is injected server-side — that's exactly why the proxy seat exists."],
    ["Hub already has the precedent", "the /services/:name/*path passthrough route is the same shape."],
    ["WS upgrades are a solved problem", "stdlib ReverseProxy has done WebSocket upgrades since Go 1.12."],
    ["Nobody rewrites UX", "the extension keeps its panel/tree; tackle2-ui gains chat it has zero WS code for today."],
  ];
  const gap = 0.28, cw = (W - 2 * M - gap) / 2, chh = 1.15, y0 = 2.35;
  pts.forEach((p, i) => {
    const x = M + (i % 2) * (cw + gap), y = y0 + Math.floor(i / 2) * (chh + 0.22);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: chh, rectRadius: 0.09, fill: { color: INK2 }, line: { color: "343A6B", width: 1 } });
    s.addImage({ data: IC.bolt, x: x + 0.24, y: y + 0.24, w: 0.26, h: 0.26 });
    s.addText(p[0], { x: x + 0.62, y: y + 0.18, w: cw - 0.78, h: 0.32, fontFace: F, fontSize: 12.5, bold: true, color: LIGHT, margin: 0 });
    s.addText(p[1], { x: x + 0.62, y: y + 0.5, w: cw - 0.8, h: 0.6, fontFace: F, fontSize: 10, color: "A7ACD6", margin: 0, lineSpacingMultiple: 1.02 });
  });
  footer(s, 12, true);
  s.addNotes("This is the architectural ask that matters most: the shim isn't throwaway, it's a working reference for the Hub passthrough proxy. Point at ADR 0004.");
}

// ---------- 12. verified contract facts ----------
function slideContract() {
  const s = pres.addSlide(); s.background = { color: LIGHT };
  kicker(s, "verified against the live controller", M, 0.5);
  title(s, "Contract facts every client depends on", M, 0.82);
  s.addText("Worth stating in the CRD comments / API docs — or every UI team rediscovers them via a 422.", {
    x: M, y: 1.5, w: 9, h: 0.35, fontFace: F, fontSize: 12.5, color: MUTED, margin: 0 });
  const rows = [
    ["cube", "Pod name == status.sandboxName == run name", "No suffix. Clients resolve the pod strictly from status.sandboxName."],
    ["key", "ACP key Secret data key is secret-key", "Referenced via status.secretKeyRef.name — don't make harnesses guess."],
    ["net", "Auto-created Service is headless & portless", "Dial <sandboxName>.<ns>.svc:4000; out-of-cluster tooling port-forwards the pod."],
    ["lock", "Whole-spec immutability (self == oldSelf)", "Client edit/retry is delete + recreate — intentional, but say so."],
  ];
  const y0 = 2.0, rh = 0.64, rg = 0.13;
  rows.forEach((r, i) => {
    const y = y0 + i * (rh + rg);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: M, y, w: W - 2 * M, h: rh, rectRadius: 0.07, fill: { color: TINT }, line: { color: HAIR, width: 1 } });
    iconCircle(s, r[0], M + 0.2, y + (rh - 0.4) / 2, 0.4, LIGHT);
    s.addText(r[1], { x: M + 0.78, y, w: 5.1, h: rh, fontFace: MONO, fontSize: 12, bold: true, color: BODY, valign: "middle", margin: 0 });
    s.addText(r[2], { x: M + 5.95, y, w: W - 2 * M - 6.1, h: rh, fontFace: F, fontSize: 10, color: MUTED, valign: "middle", margin: 0, lineSpacingMultiple: 0.98 });
  });
  footer(s, 13, false);
  s.addNotes("These are cheap doc changes but they save every downstream client real pain. This slide is upstream ask #3.");
}

// ---------- 13. upstream asks ----------
function slideAsks() {
  const s = pres.addSlide(); s.background = { color: LIGHT };
  kicker(s, "the upstream asks", M, 0.5);
  title(s, "Four findings — all pre-merge, none block", M, 0.82);
  const asks = [
    ["tag", "1", "Sandbox pods carry no agentrun label", "Set konveyor.io/agentrun on the PodTemplate — label discovery silently breaks. Verified patch attached.", GREEN, "patch"],
    ["key", "2", "LLMProvider creds are single-key", "SigV4/Bedrock needs 3 keys. Let the controller envFrom the provider secret, or make credentialRef a list.", AMBER, "design"],
    ["book", "3", "Document the contract facts", "Pod==sandboxName, secret-key, headless portless Service, whole-spec immutability — in CRD comments.", INDIGO, "docs"],
    ["layers", "4", "Skills break on docker-runtime clusters", "ImageVolume unsupported by cri-dockerd → runs never start; phase=Running masks it. Repro attached.", RED, "blocks dev"],
  ];
  const gap = 0.28, cw = (W - 2 * M - gap) / 2, chh = 1.42, y0 = 1.75;
  asks.forEach((a, i) => {
    const x = M + (i % 2) * (cw + gap), y = y0 + Math.floor(i / 2) * (chh + 0.22);
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w: cw, h: chh, rectRadius: 0.09, fill: { color: LIGHT }, line: { color: HAIR, width: 1 }, shadow: shadow() });
    s.addShape(pres.shapes.OVAL, { x: x + 0.22, y: y + 0.24, w: 0.5, h: 0.5, fill: { color: INDIGO }, line: { type: "none" } });
    s.addText(a[1], { x: x + 0.22, y: y + 0.24, w: 0.5, h: 0.5, fontFace: F, fontSize: 18, bold: true, color: LIGHT, align: "center", valign: "middle", margin: 0 });
    s.addText(a[2], { x: x + 0.86, y: y + 0.18, w: cw - 2.25, h: 0.5, fontFace: F, fontSize: 12, bold: true, color: BODY, margin: 0, lineSpacingMultiple: 0.95 });
    // status chip
    const chW = 0.26 + a[5].length * 0.072;
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: x + cw - chW - 0.18, y: y + 0.2, w: chW, h: 0.3, rectRadius: 0.15, fill: { color: a[4] }, line: { type: "none" } });
    s.addText(a[5], { x: x + cw - chW - 0.18, y: y + 0.2, w: chW, h: 0.3, fontFace: F, fontSize: 8, bold: true, color: LIGHT, align: "center", valign: "middle", margin: 0 });
    s.addText(a[3], { x: x + 0.86, y: y + 0.66, w: cw - 1.05, h: 0.7, fontFace: F, fontSize: 10, color: MUTED, margin: 0, lineSpacingMultiple: 1.0 });
  });
  s.addText([{ text: "Full write-ups, ready to paste as review comments: ", options: { color: MUTED } }, { text: "docs/UPSTREAM-FEEDBACK.md", options: { fontFace: MONO, color: INDIGO, bold: true } }], {
    x: M, y: 5.0, w: 9, h: 0.3, fontFace: F, fontSize: 11, margin: 0 });
  footer(s, 14, false);
  s.addNotes("The whole reason to present this to Konveyor. Emphasize: cheapest to absorb before merge, and nothing here blocks PR #4 landing. Delivery is a human decision — none of this is auto-posted.");
}

// ---------- 14. close ----------
function slideClose() {
  const s = pres.addSlide(); s.background = { color: INK };
  s.addShape(pres.shapes.OVAL, { x: -1.6, y: 2.8, w: 5, h: 5, fill: { color: VIOLET, transparency: 85 }, line: { type: "none" } });
  s.addShape(pres.shapes.OVAL, { x: 7.4, y: -1.8, w: 4.6, h: 4.6, fill: { color: INDIGO, transparency: 84 }, line: { type: "none" } });
  s.addText("WHAT LANDS", { x: M, y: 1.0, w: 8, h: 0.3, fontFace: F, fontSize: 12.5, bold: true, color: CYAN, charSpacing: 3, margin: 0 });
  s.addText([
    { text: "Verified today. ", options: { color: LIGHT } },
    { text: "Small asks pre-merge.", options: { color: CYAN } },
  ], { x: M, y: 1.45, w: 8.8, h: 1.3, fontFace: F, fontSize: 40, bold: true, margin: 0, lineSpacingMultiple: 0.98 });
  const lines = [
    "Two clients + two agents already ride one AgentRun / ACP contract against the real controller.",
    "hub-shim is a working reference for the Hub passthrough proxy — only that lane changes later.",
    "Four findings make PR #4 work for every client; all pre-merge, none blocking.",
  ];
  s.addText(lines.map((l) => ({ text: l, options: { bullet: { indent: 14 }, breakLine: true, paraSpaceAfter: 10, color: "CBCFEE", fontSize: 13.5 } })), {
    x: M, y: 2.95, w: 8.6, h: 1.5, fontFace: F, margin: 0, lineSpacingMultiple: 1.05 });
  s.addText([{ text: "docs/DEMO.md", options: { fontFace: MONO, color: LIGHT, bold: true } }, { text: "   ·   ", options: { color: "6E73A0" } }, { text: "docs/UPSTREAM-FEEDBACK.md", options: { fontFace: MONO, color: LIGHT, bold: true } }, { text: "   ·   ", options: { color: "6E73A0" } }, { text: "docs/adr/0004", options: { fontFace: MONO, color: LIGHT, bold: true } }], {
    x: M, y: 4.7, w: 9, h: 0.3, fontFace: F, fontSize: 11, margin: 0 });
  footer(s, 15, true);
  s.addNotes("Close on the two-part message: it already works over one contract, and the asks are small and pre-merge. Point to the three docs.");
}

(async () => {
  await loadIcons();
  slideTitle();
  slideTldr();
  slideStack();
  slideRunningOrder();
  slideGif(5, "beat 1 · create", "Create a run in the browser", "01-create-mock-run.gif",
    "Create form → Running → chat auto-connects over WS",
    ["No repository field: repository, branch and git creds resolve from the application (ADR 0005).",
     "SPA POSTs the shim → real controller creates the Sandbox CR → phase flips Pending → Running.",
     "Delete from the kebab: Sandbox, pod, Service, secret all cascade-GC."], "agent: migration-analyzer");
  slideGif(6, "beat 2 · permission", "The permission diff — the money shot", "02-permission-diff-browser.gif",
    "A reviewable javax→jakarta diff, before you approve",
    ["Prompt carries TEST_PERMISSION → request_permission with standard ACP diff blocks.",
     "The UI renders the actual code diff — the Konveyor migration story, as a diff.",
     "Reject, then re-run and Allow; the outcome echoes back. HITL, end to end."], "TEST_PERMISSION");
  slideGif(7, "beat 3 · handoff", "Attach to the same run in VSCode", "03-vscode-attach-permission.gif",
    "The extension matches the workspace repo and attaches",
    ["A toast offers to attach the run whose repository param matches the git remote.",
     "The same permission round-trip renders in the IDE panel next to the code.",
     "Same run, same session, two shells — the extension kept its existing UX."], "feature/cluster-agent");
  slideGif(8, "beat 4 · real model", "goose + Bedrock, a grounded answer", "04-goose-bedrock-grounded.gif",
    "A real tool call on the real clone — not a canned reply",
    ["Same CR, real agent base: entrypoint clones the repo, maps model env, runs goose serve.",
     "Ask a verifiable question → real tree /workspace tool call → Maven / pom.xml.",
     "Claude on Bedrock reading the actual checkout, over the same shim + WS path."], "migration-analyzer-goose");
  slideGif(9, "beat 5 · routing", "Pick between runs from the IDE", "05-vscode-run-selection.gif",
    "One workspace, several runs — choose which to attach",
    ["Konveyor: Attach to Cluster Agent — the on-demand version of the toast.",
     "The extension lists live runs and routes the panel to the one you pick.",
     "Run discovery is by label — see upstream ask #1 (pods need the agentrun label)."], "command palette");
  slideConformance();
  slideGif(11, "conformance · live", "Drop the connection, replay the session", "06-session-load-replay.gif",
    "Disconnected → Reconnect → the transcript replays",
    ["The ACP socket dies mid-session; the UI flags it and offers Reconnect.",
     "Reconnect resumes the same sessionId — session/load replays the whole transcript from the agent, not local state.",
     "This is the exact mechanism behind the browser→IDE handoff in beat 3."], "Reconnect → session/load");
  slideSeat();
  slideContract();
  slideAsks();
  slideClose();
  await pres.writeFile({ fileName: "PR4-demo-upstream.pptx" });
  console.log("wrote PR4-demo-upstream.pptx");
})();
