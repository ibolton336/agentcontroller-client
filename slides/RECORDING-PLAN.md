# Recording plan — GIFs for `PR4-demo-upstream.pptx`

**Status: 4 of 6 recorded and embedded.** GIFs 1, 2, 4 and 6 were captured
from the live environment with Playwright (`record.js` in this directory —
`node record.js clip1|clip2|clip4|clip6` — then `to-gif.sh` to convert) and
are baked into the deck. Only the two **VSCode** shots (3 and 5) remain:
they need a manual screen recording of the extension dev host, and their
slides still show dashed drop-zones. Re-running `node build.js` embeds
whatever exists in `assets/`.

Keep every clip **≤ 12 s, silent, looping**, cropped tight to the relevant UI
(no desktop, no menu bar). Target ~1000 px wide, 12–15 fps — enough for the
eye, small enough to embed.

## The six shots

| # | File (`assets/…`) | Slide | Source | What to capture |
|---|---|---|---|---|
| 1 | `01-create-mock-run.gif` | Beat 1 | Browser `:5199` | Create form (agent `migration-analyzer`, app **Coolstore**, **no repo field**) → Create → phase **Pending → Running** → chat auto-connects. |
| 2 | `02-permission-diff-browser.gif` | Beat 2 | Browser `:5199` | Send a prompt containing `TEST_PERMISSION` → the **javax→jakarta diff** renders → click **Reject**, then re-send and **Allow**; outcome echoes back. |
| 3 | `03-vscode-attach-permission.gif` | Beat 3 | VSCode | The **"Attach to it?"** toast → Attach → the permission round-trip renders **in the IDE panel** next to the code. |
| 4 | `04-goose-bedrock-grounded.gif` | Beat 4 | Browser `:5199` | Ask *"What build system does this use? Name two files at the repo root."* → real `tree /workspace` tool-call card → grounded **Maven / pom.xml** answer. |
| 5 | `05-vscode-run-selection.gif` | Beat 5 | VSCode | Command palette → **`Konveyor: Attach to Cluster Agent for This Workspace`** → the run picker → panel routes to the chosen run. |
| 6 | `06-session-load-replay.gif` | Slide 11 (conformance, live) | Browser `:5199` | Q&A → **sever the ACP socket** (the UI's `sessionId` is in-memory, so a hard refresh does *not* replay) → *Disconnected* alert → **Reconnect** → the transcript **replays from `session/load`**. |

> `TEST_DROP` caveat: the harness's pod-side socket destroy is currently
> absorbed by the shim's port-forward tunnel (browser never sees the close;
> fix filed) — which is why clip 6 severs the browser-side socket instead.

## Pre-flight (so the beats are live)

```sh
hack/demo-up.sh      # cluster + shim + UI, prints URLs
hack/demo-check.sh   # exit 0 = every surface (incl. session/load) is green
```

For Beat 4 you need the real agent Ready: `migration-analyzer-goose` (goose +
Bedrock) — `demo-check.sh` reports it. Beats 1–3, 5, 6 run on the free mock.

## Record → convert (macOS)

**Record** a tight region with the built-in recorder: `⌘⇧5` → *Record Selected
Portion* → drag over just the UI → Record → stop from the menu bar. Saves a
`.mov`.

**Convert to GIF.** `gifski` gives the cleanest result:

```sh
brew install gifski ffmpeg    # one-time

# .mov → frames → high-quality gif, capped at ~1000px / 15fps
gifski --fps 15 --width 1000 -o assets/01-create-mock-run.gif ~/Desktop/beat1.mov
```

Or pure ffmpeg (palette method — good quality, no extra tool):

```sh
ffmpeg -i beat1.mov -vf "fps=14,scale=1000:-1:flags=lanczos,palettegen" -y /tmp/pal.png
ffmpeg -i beat1.mov -i /tmp/pal.png \
  -lc_filter "fps=14,scale=1000:-1:flags=lanczos [x]; [x][1:v] paletteuse" \
  assets/01-create-mock-run.gif
```

If a GIF lands > ~8 MB, drop `--width` to 820 or `--fps` to 12.

## Drop into the deck

Modern PowerPoint (Microsoft 365 / 2016+) **auto-plays animated GIFs in
Slideshow** — no click needed.

1. Open `PR4-demo-upstream.pptx`, go to the beat slide.
2. **Insert → Pictures → This Device →** pick the matching `assets/…gif`.
3. Position it over the dashed drop-zone (it's sized ~5.75″ × 3.25″); resize to
   fit, then delete or send-to-back the placeholder rectangle + film icon.
4. Presenter View: play the slide to confirm the GIF loops.

Prefer to keep the deck editable? Leave the placeholders and present the live
app for those beats — the slide captions still tell the story.

## Rebuilding the deck

```sh
npm install          # pptxgenjs, react-icons, react, react-dom, sharp
node build.js        # writes PR4-demo-upstream.pptx
python3 <path-to-pptx-skill>/scripts/rezip.py PR4-demo-upstream.pptx  # recompress
```

Edit copy/structure in `build.js` (one function per slide).
