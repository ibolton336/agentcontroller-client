#!/usr/bin/env node
// Build a single-file, sendable copy of the story deck: every png/webm/gif is
// inlined as a data: URI so the .html works with no sibling assets/ directory.
// The webm -> gif autoplay fallback keeps working via a data-gif attribute,
// since currentSrc is a data: URI in the standalone build and can't be rewritten.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, 'quarkus-demo-story.html');
const OUT = path.join(__dirname, 'quarkus-demo-story.standalone.html');
const CRIB = path.join(__dirname, 'quarkus-demo-notes.html');
const MIME = { '.png': 'image/png', '.gif': 'image/gif', '.webm': 'video/webm' };

const dataUri = (rel) => {
  const file = path.join(__dirname, rel);
  const buf = fs.readFileSync(file);
  return `data:${MIME[path.extname(file)]};base64,${buf.toString('base64')}`;
};

let html = fs.readFileSync(SRC, 'utf8');

// <video src="....webm"> -> inline webm + inline gif fallback on data-gif
html = html.replace(/<video src="([^"]+\.webm)"/g, (_, rel) => {
  const gif = rel.replace(/\.webm$/, '.gif');
  return `<video src="${dataUri(rel)}" data-gif="${dataUri(gif)}"`;
});

// <img src="....png">
html = html.replace(/src="(assets\/[^"]+)"/g, (_, rel) => `src="${dataUri(rel)}"`);

// The fallback derived the gif path from currentSrc; use the inlined attribute.
html = html.replace(
  "img.src = v.currentSrc.replace(/\\.webm$/, '.gif');",
  'img.src = v.dataset.gif;'
);
if (html.includes('currentSrc.replace')) {
  console.error('WARN: gif-fallback patch did not apply — check the source deck');
}

// The shared copy carries no speaker notes at all — stripped, not merely hidden, so
// the `s` toggle can't surface them on someone else's screen. Notes live in the crib
// sheet below, which stays local.
html = html.replace(/\n\s*<div class="say">[\s\S]*?<\/div>/g, '');
html = html.replace(/\n\s*<div class="hint">[\s\S]*?<\/div>/, '');

fs.writeFileSync(OUT, html);
console.log(`${path.basename(OUT)}  ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB`);

// Crib sheet: every beat's speaker note on one printable page, for a phone or a
// second monitor — the only place notes are safe when you're sharing your screen.
//
// DETAILS: per-beat technical substance (mechanism / numbers / likely question),
// indexed by beat order. The say line is the patter; these are what you actually
// need to know when someone asks a follow-up. All claims verified against the
// #53 harness + controller source and the live demo-2 run.
const DETAILS = [
  // 1 — analysis
  [
    `<b>What's on screen:</b> Hub Issues view for coolstore, 26 issues against <code>konveyor.io/target=quarkus</code>. The raw insights API has 49 (18 mandatory) — issues view groups them.`,
    `<b>How it got there:</b> analyzer task POSTed with explicit <code>"extensions": ["java"]</code> — the default task requests ~5.1Gi (java+nodejs+python) and is unschedulable on this node.`,
    `<b>Where it goes next:</b> the harness pulls these same insights via <code>GET /applications/1/analysis/insights</code> into every stage's workspace. Nothing points at them manually.`,
  ],
  // 2 — skills / agents / workloads
  [
    `<b>Agent</b> = image (Savita's harness IS the entrypoint) + provider <i>allowlist</i> + declared params (<code>max_turns</code>=150) + persona prompt. No credentials anywhere in the spec.`,
    `<b>Creds:</b> LLMProvider <code>credentialRef</code> → Secret; Bedrock is the keyless form → whole secret via <code>envFrom</code>. Git PAT resolves from the Hub source Identity at run time.`,
    `<b>Skills:</b> five baked at <code>/opt/skills</code> (plan, execute, verify, javaee-to-quarkus, patternfly-migration). <code>skillCards</code> would ImageVolume-mount into the same dir — harness globs <code>*/SKILL.md</code> either way.`,
    `<b>If asked "does it pick the right skill?":</b> no — ALL skills concatenate into every prompt; the stage instructions decide which apply (the guide explicitly demotes patternfly).`,
  ],
  // 3 — one run, three stages
  [
    `<b>Mechanism:</b> WorkloadRun spec is immutable (CEL). Controller creates ONE stage AgentRun at a time → Sandbox CR → upstream agent-sandbox v0.5.0 stamps the pod. Next stage only after Succeeded; any failure fails the run, no retries.`,
    `<b>Handoff:</b> each pod is fresh (10Gi emptyDir, new clone). <code>CheckoutBranch</code> lands on <code>origin/&lt;TARGET_BRANCH&gt;</code> at the previous stage's tip — git is the ONLY shared state. No PVC, no status files.`,
    `<b>Stage fields are just</b> <code>{name, agentRef, instructions}</code> — app/branch/models live on the run (<code>spec.env</code> + <code>spec.models</code>), copied identically to every stage.`,
  ],
  // 4 — assess
  [
    `<b>Startup order (the credential story):</b> Hub client fetches app + decrypted source Identity → clone (all refs) → strip creds from remote URL → unset <code>HUB_*</code> env → THEN goose starts. The agent can't run git because it has nothing to run git with.`,
    `<b>analysis.json:</b> written to <code>.konveyor/</code> automatically (warn-only on failure), committed to the branch — that's why the plan can cite <code>ee-to-quarkus-00020</code> by ID.`,
    `<b>Prompt =</b> persona + workload guide + all SKILL.md + stage task. Assess ran 4m18s, one commit (PLAN.md + graph.json + analysis.json).`,
  ],
  // 5 — remediate
  [
    `<b>23 minutes, the long stage.</b> Follows the execute skill against PLAN.md; the hard rules in the stage instructions (BOM discipline, extension-replaces-library, messaging topology, @RequestScoped…) came from an empirical 4-lens review of the first run's branch.`,
    `<b>Auto-commit:</b> filesystem watcher commits after 30s quiet ("konveyor: auto-commit progress"), push warn-only; final "stage complete" push is fatal on failure. Commits authored <code>migration-harness</code>.`,
    `<b>Visible obedience:</b> Flyway bootstrap class deleted (not pinned), channels split orders-out/orders-in joined by <code>.address</code>, <code>/services</code> path preserved via config.`,
  ],
  // 6 — validate
  [
    `<b>Why the gate changed:</b> the review proved a compile-only gate passes an app that cannot start — exactly 2 compile blockers (BOM artifact name, Flyway 4 API), then green compile over SRMSG00073 dual-direction channel, missing sequence, @SessionScoped without undertow.`,
    `<b>The gate now:</b> (1) <code>mvn package -DskipTests</code>, (2) boot the jar, log must reach "Listening on" clean, (3) curl <code>/services/*</code> while it runs. No Docker/testcontainers.`,
    `<b>Receipts:</b> app up in 0.976s; /services/products, /orders, /cart/mycart all 200; validate appends a Verification Results section to PLAN.md incl. honest caveats (messaging untested end-to-end, in-mem H2).`,
  ],
  // 7 — result
  [
    `<b>Real numbers:</b> 04:36:15 → 05:09:21 = 33m06s. assess 4m18s / remediate 22m37s / validate 6m11s. Model: Sonnet on Bedrock, max_turns 150/stage.`,
    `<b>7 commits, not 3</b> — continuous auto-commits plus two "stage complete" markers (remediate's final commit was empty; the watcher had already swept it). The branch is a live log, stage boundaries live in the run detail.`,
    `<b>Known risk if a stage dies:</b> pod is RestartPolicy OnFailure → crash-loop re-runs the stage while the run shows Running. Delete the run; spec is immutable, there's no cancel.`,
  ],
  // 8 — PR
  [
    `<b>Push identity:</b> the Hub source Identity's PAT — same mechanism proven on fork-w8vfb. Branch <code>quarkus-migration-demo-2</code> on ibolton336/coolstore, "Able to merge".`,
    `<b>Get ahead of the diff:</b> compare shows −684k lines / ~2,548 files — src/main/webapp deliberately dropped per the disposition recorded in PLAN.md (JAR packaging serves no JSP/AngularJS). Say it before they see it.`,
    `<b>Honest caveats to volunteer:</b> cart is still a single shared instance (known), messaging end-to-end untested, in-mem H2 in prod profile. All written into PLAN.md by validate — that IS the governance story.`,
  ],
];

const src = fs.readFileSync(SRC, 'utf8');
const beats = [...src.matchAll(
  /<div class="beat">(.*?)<\/div>\s*<h1>(.*?)<\/h1>[\s\S]*?<div class="say"><b>Say:<\/b>([\s\S]*?)<\/div>/g
)].map(([, beat, title, say], n) => `
  <li>
    <div class="beat">${beat}</div>
    <h2>${title}</h2>
    <p>${say.trim()}</p>
    <ul class="tech">${(DETAILS[n] || []).map((d) => `\n      <li>${d}</li>`).join('')}
    </ul>
  </li>`).join('');

// Demo-day cheat sheet, appended below the beat notes. Kept here (not hand-edited
// into the generated file) so a rebuild never loses it.
const cheatSheet = `
<h1 style="margin-top:2.4rem">Cheat sheet — architecture &amp; numbers</h1>

<h3>Stack, one breath</h3>
<p>tackle2-ui → <b>hub-shim</b> (shape of the future Hub API for agents/runs/skills) →
agentic controller + real Hub on minikube. We create a <b>Sandbox CR</b>; the upstream
agent-sandbox controller stamps the pod.</p>

<h3>Entities, in speaking order</h3>
<table>
<tr><td><code>LLMProvider</code></td><td>where Bedrock creds live (<code>credentialRef</code> → Secret) — never in any other spec</td></tr>
<tr><td><code>Agent</code></td><td>governed capability: harness <b>image</b> (Savita's), provider <i>allowlist</i>, params, persona prompt</td></tr>
<tr><td><code>AgentWorkload</code></td><td>the <b>method</b>: guide + stages. Knows no app — reusable, versionable</td></tr>
<tr><td><code>AgentWorkloadRun</code></td><td>the <b>binding</b>: application + target branch + model. This is what I create live</td></tr>
<tr><td><code>AgentRun</code></td><td>one stage's execution — created <i>by</i> the controller, one at a time, never pre-created</td></tr>
</table>

<h3>On create</h3>
<p>Pick <b>application</b> + branch — never type a token (shim injects <code>HUB_TOKEN</code> as a
secretKeyRef). Controller → stage AgentRun → Sandbox → pod. Harness: Hub client fetches app +
git identity → clone → <b>strip creds, wipe Hub env</b> → writes <code>.konveyor/analysis.json</code>
automatically → goose. Prompt = persona + guide + <b>all</b> baked skills + stage instructions.
Auto-commit on 30s quiet; <b>the branch is the only handoff</b> between stages.</p>

<h3>Credentials (governance beat)</h3>
<p><b>Git PAT: structurally invisible to the agent</b> — harness memory only; remote URL scrubbed
and Hub env unset <i>before</i> goose starts. "It never runs git because it has nothing to run git
with." <b>Model creds:</b> Secret via LLMProvider; Bedrock = keyless ref → whole secret
<code>envFrom</code> (<code>AWS_*</code>); harness maps <code>KONVEYOR_MODEL_*</code> →
<code>GOOSE_*</code>.</p>

<h3>Skills — say it right</h3>
<p>All the agent's skills are in context (five baked at <code>/opt/skills</code>, incl.
javaee-to-quarkus); <b>the stage instructions decide which apply</b>. Published skill images mount
into the <i>same</i> directory — the harness can't tell the difference. ✗ Never "it picks the
right skill."</p>

<h3>Last night's numbers (run coolstore-quarkus-demo-2)</h3>
<p><b>33m06s</b> unattended, Succeeded — assess 4m → remediate 23m → validate 6m.
<b>7 commits</b> on <code>quarkus-migration-demo-2</code> (continuous auto-commits, <i>not</i> one
per stage) — "the branch is a live log of the work." Plan cites real rule IDs
(<code>ee-to-quarkus-00020</code>) because analysis was in the workspace <i>before</i> the model saw
the prompt. <b>Validate gate = package + app boots (0.976s) + <code>/services/products</code> 200</b>
— green compile is not the bar. Ends "Able to merge" on GitHub — a human closes the loop.</p>

<h3>If asked / don't trip on</h3>
<p>Compare shows <b>−684k lines</b>: webapp deliberately dropped per recorded disposition — say it
before they see it. Cart is a known shared-state caveat; validate writes honest caveats into
PLAN.md. Stages = <code>{name, agentRef, instructions}</code> only; app/branch/model live on the
<b>run</b>. Same agent × 3 stages, different instructions — by design.</p>`;

fs.writeFileSync(CRIB, `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Speaker notes — Findings → Pull Request</title>
<style>
  body { font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
         max-width: 46rem; margin: 0 auto; padding: 1.5rem 1.2rem 4rem; background: #0d1117; color: #e6edf3; }
  h1 { font-size: 1.15rem; color: #8b949e; font-weight: 600; margin: 0 0 1.4rem; }
  ol { list-style: none; counter-reset: b; padding: 0; margin: 0; }
  li { counter-increment: b; border-top: 1px solid #30363d; padding: 1rem 0 .3rem 2.2rem; position: relative; }
  li::before { content: counter(b); position: absolute; left: 0; top: 1rem;
               color: #58a6ff; font-weight: 700; font-variant-numeric: tabular-nums; }
  .beat { color: #58a6ff; font-size: .7rem; letter-spacing: .12em; text-transform: uppercase; font-weight: 700; }
  h2 { font-size: 1rem; margin: .2rem 0 .45rem; }
  h3 { font-size: .82rem; color: #58a6ff; letter-spacing: .1em; text-transform: uppercase; margin: 1.3rem 0 .35rem; }
  ul.tech { list-style: none; margin: .55rem 0 0; padding: 0; }
  ul.tech li { counter-increment: none; border: 0; padding: .25rem 0 .25rem 1rem; position: relative;
               color: #b6c0cb; font-size: .92rem; }
  ul.tech li::before { content: "–"; position: absolute; left: 0; top: .25rem; color: #30363d; font-weight: 400; }
  ul.tech b { color: #e6edf3; }
  p { margin: 0 0 .4rem; color: #b6c0cb; }
  p b, td b { color: #e6edf3; }
  table { border-collapse: collapse; width: 100%; margin: .2rem 0 .4rem; }
  td { border-top: 1px solid #30363d; padding: .35rem .6rem .35rem 0; vertical-align: top; color: #b6c0cb; font-size: .93rem; }
  td:first-child { white-space: nowrap; }
  code { background: #21262d; padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  @media print { body { background: #fff; color: #000; max-width: none; }
                 p, td { color: #333; } li, h3 { break-inside: avoid; } code { background: #eee; } }
</style></head>
<body>
<h1>Speaker notes — Findings → Pull Request (${beats.match(/<li>/g)?.length ?? 0} beats)</h1>
<ol>${beats}
</ol>
${cheatSheet}
</body></html>
`);
console.log(`${path.basename(CRIB)}  ${[...src.matchAll(/class="say"/g)].length} notes`);
