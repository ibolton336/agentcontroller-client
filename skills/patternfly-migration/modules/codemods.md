# Phase 2: Codemods

PatternFly ships an official codemod suite that mechanizes most v5→v6 API
renames. Run it before hand-editing components — it converts the long tail
of prop renames and flags what it cannot fix.

## Run

From the project root, against the source directory (adjust `src` if the
code lives elsewhere):

```bash
npx @patternfly/pf-codemods@latest ./src --v6 --fix
```

Then a second pass to report what remains:

```bash
npx @patternfly/pf-codemods@latest ./src --v6
```

Notes:
- `--fix` edits files in place; run it on a clean working tree so the diff
  is reviewable.
- If the network blocks `npx` downloads, skip this phase and apply the
  mappings in `references/component-map.md` manually during Phase 3.

## Triage the report

The non-fixable findings fall into three buckets:

1. **Removed components** (Chip, Tile, deprecated Select/Dropdown variants,
   Text family) — handled in Phase 3 with `references/component-map.md`.
2. **Restructured props** (EmptyState header/icon composition, Masthead
   slots, Toolbar visibility props) — Phase 3.
3. **Class/token strings the codemod cannot see** (CSS files, string
   concatenation, test selectors) — Phase 4.

Record every remaining finding as a checklist before moving on; Phase 3
and 4 must clear all of them.

## Gate

Run the build. Codemod output alone rarely compiles when removed
components are in use — that is expected; confirm the remaining errors
map 1:1 to the recorded checklist, then proceed to Phase 3.
