# Pre-phase: PatternFly 4 → 5 (only when the app is on v4)

Detect: `@patternfly/react-core` major is `^4` or class prefixes are bare
(`pf-c-*` — v4 had no version prefix). If the app is already on v5, skip
this module entirely.

v4→v5 is mostly mechanical and must land (and build) before the v5→v6
phases:

1. Bump every `@patternfly/*` package to its v5-aligned major
   (`react-core` `^5`, `react-charts` `^7`, css `^5`). React 17+ required.
2. Run the v5 codemods:
   ```bash
   npx @patternfly/pf-codemods@^2 ./src --fix
   ```
3. Class prefixes gain the version: `pf-c-button` → `pf-v5-c-button`,
   `pf-u-*` → `pf-v5-u-*`; global variables `--pf-global--*` →
   `--pf-v5-global--*`. Update stylesheets and test selectors.
4. Renames the codemod flags: Select/Dropdown move to `/deprecated` import
   paths (leave them there — Phase 3 of the main flow replaces them
   properly), `Title` size props, `KebabToggle` removal.

Gate: `npm run build` passes on v5 with zero unprefixed `pf-c-`/`pf-u-`
references, then return to Phase 1 of `SKILL.md`.
