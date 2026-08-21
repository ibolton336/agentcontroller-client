# PR #148 review — `:seedling: Build all agent images multi-arch`

Upstream: https://github.com/konveyor/agentic-controller/pull/148 (Savitha, branch
`issue125` on her fork, head `5413126`, base `c6720c5`; main is 2 commits ahead:
#149 401/403 fix, #156 PR conventions). Refs #125. Reviewed 2026-08-19.

Posted as **APPROVED** 2026-08-19 — https://github.com/konveyor/agentic-controller/pull/148#pullrequestreview-4973709793. Status at review time: CI fully green (DCO, lint, e2e, harness tests, 10
artifact jobs, 2 controller jobs; the two multi-arch **push** jobs are skipped on
PRs and have therefore **never executed** — the merge itself will be their first
run, because `images/README.md` matches the `images/**` push filter).
CodeRabbit's three nits (SHA-pin, stray apostrophe, `mkdir -p`) were fixed in
the later commits. No human review yet.

## Verdict

**LGTM with two small pre-merge asks** (both two-liners) and a handful of
take-or-leave nits. Nothing blocks. The PR-time path is proven by the green run
and by loading its artifacts locally; the push path reuses release-tools'
`build-push-images.yaml`, which ran green this week in tackle2-hub and
analyzer-lsp on the same runner images, but has not been run against *these*
Containerfiles — whoever merges should watch the first main run.

## What was tested locally (Apple Silicon, Docker Desktop, no podman)

| Check | Result |
|---|---|
| `make harness-build` native | Mach-O arm64, `--help`/`run --help` exit 0 |
| cross-compile linux/amd64, linux/arm64 | static ELF x86-64 / aarch64 |
| cross-compile windows/amd64 | `harness/bin/migration-harness.exe` (PE32+), non-.exe gone |
| cross-compile darwin/amd64 | Mach-O x86_64; stale `.exe` from the previous build survives |
| cgo in dep graph | none; cross builds auto-`CGO_ENABLED=0`, native darwin inherits `=1` |
| `make help` | three new targets listed, awk pattern fine |
| `make -n agent-images-multiarch-{build,push}` + fake `podman` on PATH | 15 calls in the right order, loop splits `lang`/`img` on the first colon, `AGENT_PLATFORMS`/`AGENT_*_IMG` overrides honoured, `\|\| exit 1` aborts the loop |
| `export` on `AGENT_*` vars | inert — no consumer anywhere (Makefile/hack/test/workflows) |
| PR artifacts (run 32178014347): all 5 arm64 + agent-base amd64 | `docker load` → `localhost/agent-<x>:pr148-<arch>` |
| image config | Arch arm64/v8 (amd64 for the amd64 one), user 1001, ENTRYPOINT `migration-harness`, CMD `run`, WORKDIR `/workspace`, HOME `/home/harness` |
| binaries genuinely native | goose 1.45.0 and harness are e_machine 0xB7 (aarch64) / 0x3E (x86-64) |
| toolchains | go1.26.5, OpenJDK 21.0.12 + Maven 3.9.9 (`JAVA_HOME` → `/usr/lib/jvm/java-current`), .NET SDK 8.0.130, Node 22.23.1/npm 10.9.8, git 2.52, Python 3.12.13, graphifyy 0.7.17 — hello-world compiled/ran in each |
| bare entrypoint, no env | fails fast (<1 s, rc 1) with `required env var … is not set`; never hangs |
| uid 1001 and random uid (12345:0, 12345) | `/workspace`, `/home/harness`, `/var/tmp` writable; `/opt/skills` not (expected) |
| amd64 agent-base under Rosetta | `uname -m` = x86_64, goose/harness run |
| build tooling stripped from agent-base | yes (gcc etc. "not installed"); agent-go brings gcc back via `golang-bin` (+411 MB) |

Not exercised: the real podman multi-platform build/push (no podman here). Only
dry-runs + a fake-podman trace.

## Findings (ranked; severities after adversarial verification)

### Should fix before merge (cheap)

1. **Language images on `workflow_dispatch` from a non-main ref build on the
   wrong base.** release-tools tags with `inputs.tag || (ref==main ? latest :
   ref_name)`, so a dispatch from branch `foo` pushes `agent-base:foo{,-amd64,-arm64}`;
   but `agent-lang-images-multiarch` passes no `extra-args`, so the four language
   Containerfiles fall back to `ARG BASE_IMAGE=quay.io/konveyor/agent-base:latest`
   and the published `agent-go:foo` etc. are built on main's base — the
   `agent-base:foo` publish is unused, and the in-file comment/README claim
   ("resolves against an already-published … base") only holds on main.
   Today it's worse: quay's `agent-base:latest` is still a single amd64
   manifest, so the arm64 language legs of a branch dispatch would pull an
   amd64 base on a native arm runner and die at the first `RUN` (exec format
   error) — i.e. a pre-merge dispatch test currently cannot pass.
   Fix (kantra uses the same idiom in `multi-arch-image-build.yaml`):
   ```yaml
   # agent-lang-images-multiarch.with
   extra-args: |
     --build-arg BASE_IMAGE=quay.io/konveyor/agent-base:${{ github.ref == 'refs/heads/main' && 'latest' || github.ref_name }}
   ```
   (`images.yml:175-184`, `release-tools build-push-images.yaml:67-68,177-183`,
   `images/agent-*/Containerfile:6`.)

2. **No `concurrency` group.** Every other konveyor caller of
   `build-push-images.yaml` (tackle2-hub `march-image-build-push.yml`, kantra
   `multi-arch-image-build.yaml`, …) sets `concurrency: group: march-build-${{ github.ref }}`.
   Without it, two main pushes inside the ~10-min pipeline can interleave: the
   manifest job resolves `:latest-<arch>` **by tag** at run time, and the
   language builds pull whatever `agent-base:latest` is current, so `:latest`
   can end up a mix of two commits. Pre-existing absence, but the old single-job
   flow built base+language in one runner from local images and couldn't
   cross-contaminate; the new base→registry→language hop can. Suggest
   `group: images-${{ github.ref }}`, `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`
   (don't cancel a half-published main run between arch pushes and manifest assembly).

### Nits (take or leave)

3. **`make agent-images-push` is a demotion footgun now.** Still documented in
   `images/README.md:34` as "push to quay (native arch)" with
   `AGENT_*_IMG` defaulting to the production `quay.io/konveyor/*:latest`. After
   this merges `:latest` is a manifest list; a maintainer running it from a
   laptop overwrites all five with single-arch images until the next main push.
   Either point the README push line at `agent-images-multiarch-push`, or add a
   warning/`FORCE_SINGLE_ARCH=1` guard.

4. **"the same action analyzer-lsp's demo-testing.yml uses"** (`images.yml:59`,
   `README.md:74`) is only transitively true: demo-testing → konveyor/ci
   `e2e-image-build.yaml` → `build-nightly-images.yaml` → `konveyor/ci/build-image`.
   Code search shows this PR is the first direct external caller. Reword or drop.

5. **PR-artifact docs omit three things a tester needs**: the shared action
   hardcodes `retention-days: 1` (this PR's artifacts expire 2026-08-19
   ~19:42 UTC; a "Re-run failed jobs" of a language leg after expiry fails
   loudly on an empty `BASE_IMAGE`); the tar is a docker-archive so
   `docker load -i` works too; it loads as `localhost/<image>:pr<N>-<arch>`.

6. **`localhost/` rationale goes stale the day this merges.** Makefile
   `:170-178` and README `:57-65` justify the trick with "(single-arch)
   published image … baking the wrong architecture". Verified mechanism
   (containers/common `libimage/pull.go`): whenever `--platform` is set,
   libimage forces pull policy `newer` for registry-named FROMs (podman ≥ 4.0),
   so podman re-pulls quay's image over the locally built list — today
   single-arch → wrong arch + the quoted warning; after this PR multi-arch →
   **silently** builds on the published base instead of your local one. The
   trick stays necessary, the stated reason doesn't. Say "already-published"
   and consider `--pull=never` on the four language-image builds (exempt from
   the forced-newer override, fails fast if the per-platform instance is
   missing; must NOT go on the agent-base build).

7. **Linux hosts need `qemu-user-static` (+binfmt) for the foreign platform**;
   podman machine on macOS/Windows ships it. README says only "Requires podman".

8. **`harness-build` polish**: add `CGO_ENABLED=0` for parity with the
   Containerfile (native Linux build would otherwise link glibc); `go build -o bin/`
   (directory form) names the output `.exe` on windows by itself and creates the
   dir, so the `mv` and `mkdir -p` can go. Also `harness/bin` is not in the root
   `.dockerignore` (`bin/` only matches top-level) — proven: a scratch `COPY
   harness/bin/` against the repo root pulled 34 MB of stale cross-builds into
   the context. Add `harness/bin/` (or `**/bin/`) to `.dockerignore`.

9. **`export` on `AGENT_*_IMG`/`AGENT_PLATFORMS`** has no consumer — drop or
   say what's meant to read it.

10. **SHA pins to sibling konveyor repos with no dependabot/renovate.**
    CodeRabbit asked for pins; fine, but `.github/` has no dependabot config, so
    `konveyor/ci/build-image@e45ec03` and `release-tools@4cf4ec7` will never
    move (konveyor/ci just had to ship a crun hotfix for a runner regression).
    Every other konveyor caller uses `@main` for same-org refs. Either is OK;
    make it deliberate (one-line question).

11. **PR body is the squash-merge commit message here** and still describes the
    first-commit design ("via podman manifest lists"); update to the final
    shape (release-tools on push/dispatch, per-arch konveyor/ci artifacts on
    PRs, podman lists only for the local target).

12. **Scope sentence**: controller + controller-agent images stay amd64-only
    (unchanged jobs), so "multi-arch" ≠ arm64 clusters end-to-end. One line in
    README/PR body pre-empts the question.

### Questions

- **Does this close #125?** Its "Done when" (four images multi-arch in CI,
  published) is met; "ghcr" is quay.io/konveyor in practice and "skills
  pre-baked" was superseded by SkillCards (README:21-22, ADR 0014/0015). If
  yes → `Fixes #125` + a closing note; if not, what remains?
- How was the push path validated? A pre-merge `workflow_dispatch` from the
  branch needs the branch pushed to upstream (PR is from a fork), only works
  after fix 1, and — caution — the unchanged controller/controller-agent jobs
  push `:latest` from any dispatched ref, so dispatching from `issue125`
  (based on `c6720c5`) would overwrite `agentic-controller:latest` without
  #149. Rebase first, or skip the dispatch and watch the first main run.

### Positively verified (no action)

- `vars.QUAY_USERNAME` inside `jobs.<id>.secrets` of a reusable-workflow call
  is documented-valid; `matrix.*` in `with:`/`name:` likewise.
- `permissions: {}` + job `contents: read` suffices on both paths (artifact/
  cache steps use the runtime token; release-tools needs only checkout).
- Artifact-name contract holds: `FILE_NAME=<image>--<tag>` =
  `agent-base--pr148-<arch>` = the language jobs' `base_image`; logs show
  `FROM localhost/agent-base:pr148-arm64`.
- A missing/expired base artifact fails **loudly** (empty `--build-arg
  BASE_IMAGE=` → blank FROM), never silently builds on quay's base.
- `needs: agent-base-multiarch` waits for the whole called workflow incl. the
  manifest job → on main the language images always build on a freshly pushed
  multi-arch base; buildah `--arch arm64` on the native arm runner picks the
  arm64 child of the manifest list, no qemu.
- The manifest job's anonymous `podman manifest add docker://…` works because
  all five quay repos exist and are public (a sixth image would need its repo
  pre-created public).
- goose v1.45.0 ships both `x86_64`/`aarch64-unknown-linux-gnu` tarballs;
  `uname -m` under emulation reports the emulated arch.
- Fork PRs do get `ubuntu-24.04-arm` (this PR is cross-repo and ran on it).
- Changelog kinds valid; DCO on all three commits; `:seedling:` needs no
  fragment (extra fragments harmless). Fragment naming by issue number: others
  vary, not worth a comment.
- No branch protection/ruleset references the removed "Build stage agent
  images" check.

## Out of scope for #148 — follow-ups worth filing

- **`/tmp` is 0755 root:root in every agent image** (PR images and quay's
  current `agent-base:latest`; UBI10 base is 1777). Cause: the goose tarball's
  `./` entry is `drwxr-xr-x root root` and `tar -xjf … -C /tmp` as root applies
  it to `/tmp`. Commit 3ee420c/#91 blamed overlayfs and worked around it with
  an EmptyDir at `/tmp` in sandbox pods, so in-cluster runs are fine, but `go
  run`/`dotnet new` fail in the stock image locally. One-line Containerfile
  fix (extract into a subdir, or `--no-same-permissions`, or `chmod 1777 /tmp`).
- **`make changelog-validate` is broken on main**: `hack/changelog.sh` trims
  with `echo | xargs`, which dies "unterminated quote" on fragments with an odd
  number of apostrophes (107-stage-label-inheritance, harness-acp-tee,
  staging-rules). CI doesn't run it.
- `harness/bin/` missing from `.dockerignore` (see nit 8).
- agent-go reintroduces gcc/glibc-devel/binutils via `golang-bin` (+411 MB) —
  probably wanted for cgo; a README note would do.
- Controller/controller-agent images multi-arch (the Dockerfile already has
  `TARGETOS/TARGETARCH`).
- `images.yml` `paths:` omits the workflow file and `Makefile`, so a
  workflow-only follow-up PR gets no CI run.

## Draft upstream comment (short form)

> Tested locally: pulled the arm64 artifacts from run 32178014347 into Docker on an M-series Mac — all five images are genuinely aarch64 (goose 1.45.0, static harness; e_machine checked), toolchains work (go1.26.5, JDK 21 + Maven, .NET 8.0.130, Node 22), uid-1001 and random-UID writability fine, bare entrypoint fails fast, and the amd64 agent-base runs under Rosetta. `make harness-build` works natively and cross-compiles (linux/amd64, linux/arm64, windows `.exe`, darwin/amd64). Didn't run the podman targets (no podman here) — dry-runs only. Nice work.
>
> Two small asks before merge, since the push path first runs on the merge itself:
>
> 1. **Language images on a non-main `workflow_dispatch` build on the wrong base.** release-tools tags agent-base with `github.ref_name`, but the language jobs pass no `extra-args`, so they build `FROM quay.io/konveyor/agent-base:latest` (main's base) and the just-pushed `agent-base:<ref>` is never used — today that'd also fail the arm64 legs (quay's base is still single-arch amd64), so a pre-merge dispatch can't pass as-is. Same idiom kantra uses:
>    ```yaml
>    extra-args: |
>      --build-arg BASE_IMAGE=quay.io/konveyor/agent-base:${{ github.ref == 'refs/heads/main' && 'latest' || github.ref_name }}
>    ```
> 2. **`concurrency` group** — every other konveyor caller of `build-push-images.yaml` sets `concurrency: group: …-${{ github.ref }}`. Without it two main pushes inside the ~10-min pipeline can interleave (the manifest job resolves `:latest-<arch>` by tag; language builds pull whatever `agent-base:latest` is current).
>
> Nits, take or leave: `make agent-images-push` is still documented and would now overwrite the multi-arch `:latest` with a single-arch image — point that README line at the multiarch target or add a warning · "the same action analyzer-lsp's demo-testing.yml uses" is transitive (demo-testing → e2e-image-build → build-nightly-images → build-image) · artifacts expire after 1 day (shared action's `retention-days`), `docker load` works too, and the image loads as `localhost/<image>:pr<N>-<arch>` — worth a sentence · the "(single-arch) … wrong architecture" rationale for the `localhost/` trick goes stale once quay's base is multi-arch; the trick stays needed because `--platform` forces pull-policy `newer` for registry names (you'd silently build on the published base), so maybe say "already-published" and consider `--pull=never` on the four language builds · Linux hosts need `qemu-user-static` for the local multi-arch target · `harness-build`: `CGO_ENABLED=0` for parity with the Containerfile, and `-o bin/` drops the `.exe` mv; `harness/bin/` isn't in `.dockerignore` · the SHA pins to konveyor/ci and release-tools won't move without a dependabot config (other konveyor repos use `@main` for same-org refs) — fine if deliberate · PR body becomes the squash commit message and still describes the first-commit design.
>
> Q: does this close #125 (`Fixes`)? Its "ghcr"/"skills pre-baked" wording looks superseded (quay; SkillCards). And maybe one line that the controller/controller-agent images remain amd64-only so "multi-arch" isn't read as arm64 clusters end-to-end.
>
> Whoever merges: watch the first main run and check `docker manifest inspect quay.io/konveyor/agent-base:latest` (and the four language images) shows both arches.
