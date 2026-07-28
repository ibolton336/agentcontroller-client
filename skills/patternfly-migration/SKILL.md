---
name: patternfly-migration
description: Migrates React applications from PatternFly 5 to PatternFly 6.
  Use when upgrading a UI that imports @patternfly/react-core v5 (or older)
  to the PatternFly 6 design-token system, not just bumping package versions.
license: Apache-2.0
metadata:
  source: patternfly-5
  target: patternfly-6
  language: typescript
  build_tool: "npm: npm install && npm run build"
  guide_url: https://www.patternfly.org/get-started/upgrade
  generated_by: migration-skills-generator
  generated_at: 2026-07-28
---

# PatternFly 5 to PatternFly 6 Migration

**Prerequisite:** Ensure the application builds on its current PatternFly
version before starting (`npm install && npm run build`). Node.js 18+ is
required for PatternFly 6 tooling. If the app is on PatternFly 4, complete
the v4→v5 rename pass (module `modules/v4-to-v5.md`) before anything else.

This migration goes beyond bumping `@patternfly/*` versions. PatternFly 6
replaces the global CSS variable system with semantic design tokens
(`--pf-v5-global-*` → `--pf-t--global--*`), collapses the `Text`/
`TextContent`/`TextList` family into a single `Content` component, removes
deprecated components (Chip → Label, Tile → Card, page header utilities),
changes default component styling (buttons, cards, masthead), and renames
CSS classes from `pf-v5-` to `pf-v6-` prefixes. The result is an
application on the v6 token system with no `pf-v5` or global-variable
references remaining.

## Phases

Execute in order. After each phase, run the project build and stop if it
fails.

1. **Build Config** — Update `package.json`: bump `@patternfly/react-core`
   and sibling packages to v6, align React peer deps, update css/asset
   imports. See `modules/build-config.md`.
2. **Codemods** — Run `@patternfly/pf-codemods` over the source tree and
   triage its output: auto-fixes, then each reported manual item. See
   `modules/codemods.md`.
3. **Components** — Apply the component API changes codemods cannot do:
   Text→Content, Chip→Label, EmptyState restructure, Toolbar and Masthead
   signatures. See `modules/components.md`.
4. **Tokens and CSS** — Replace `--pf-v5-global-*` variables and
   `pf-v5-` class references in stylesheets and inline styles with v6
   design tokens. See `modules/tokens-css.md`.
5. **Cleanup** — Delete stale overrides written against v5 markup, verify
   no `pf-v5`, `--pf-v5-global`, or removed-component imports remain. See
   `modules/cleanup.md`.

## How to use

Load each phase's module when starting that phase. Each module contains
before/after code examples and references mapping tables in `references/`.
Apply every applicable transformation to the codebase.

## Build gate

After completing each phase:
1. Detect the project's build tool (check metadata `build_tool` field
   above, or detect from project files: `package.json` scripts — prefer
   `build`, fall back to `tsc --noEmit`)
2. Run the build
3. If it fails, fix the issue before proceeding
4. If you cannot fix it, stop and report to the user
