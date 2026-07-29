# PR #4 demo deck

Slide deck for the **agentic-controller PR #4** demo + upstream findings
(audience: Konveyor upstream).

- **[PR4-demo-upstream.pptx](PR4-demo-upstream.pptx)** — 15 slides, ready to
  present. **Four GIFs recorded from the live stack are embedded** (create-run,
  permission diff, goose grounded answer, drop→reconnect→replay); the two
  VSCode beats are dashed drop-zone placeholders.
- **[RECORDING-PLAN.md](RECORDING-PLAN.md)** — shot list + status, capture and
  convert recipes.
- **[record.js](record.js)** — the Playwright script that recorded the browser
  clips (`node record.js clip1|clip2|clip4|clip6`); **[to-gif.sh](to-gif.sh)**
  converts the webm output.
- **[build.js](build.js)** — regenerates the `.pptx` (one function per slide);
  embeds any GIF present in `assets/`, placeholder otherwise.

## Add the remaining VSCode GIFs

Record per [RECORDING-PLAN.md](RECORDING-PLAN.md) (shots 3 and 5), save into
`assets/` under the exact filenames, then `npm run build` — or in PowerPoint,
**Insert → Pictures** over the dashed drop-zones. Modern PowerPoint auto-plays
animated GIFs in Slideshow.

## Rebuild the deck

```sh
npm install
npm run build      # writes PR4-demo-upstream.pptx
```

`node_modules/`, rendered PDFs and QA JPGs are gitignored.
