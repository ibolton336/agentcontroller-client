# Phase 5: Cleanup

Verify nothing v5-era survives, and delete what the migration obsoleted.

## Checks (all must return zero hits in source)

```bash
grep -rn "pf-v5\|--pf-v5-global" src/
grep -rn "from '@patternfly/react-core'" src/ | grep -E "\b(Text|TextContent|TextList|TextListItem|Chip|ChipGroup|Tile)\b"
grep -rn "react-core/deprecated\|next/Select\|next/Dropdown" src/
grep -rn "EmptyStateHeader\|EmptyStateIcon" src/
```

## Delete

- CSS overrides written against v5 component markup that v6 restyles
  natively (spot these by reviewing every remaining custom rule that
  targets a `pf-v6-c-*` class — keep only ones with a product reason).
- Version-pinned snapshot files that only assert v5 class names; regenerate
  snapshots instead.
- Any `resolutions`/`overrides` entry in `package.json` that pinned a
  `@patternfly/*` package to v5.

## Final gate

1. `npm install` from a clean lockfile state — no peer warnings about
   `@patternfly/*`.
2. `npm run build` passes.
3. Tests pass (`npm test`) if the project has them.
4. Visual smoke: if a dev-server script exists, start it and confirm the
   app renders with v6 styling (round cards, updated masthead) and no
   unstyled regions — unstyled usually means a missed base.css or a stale
   v5 class.
