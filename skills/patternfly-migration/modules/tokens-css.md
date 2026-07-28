# Phase 4: Tokens and CSS

PatternFly 6 replaces the v5 global CSS variables with a semantic design
token system. All custom styling that referenced `--pf-v5-global-*`
variables or `pf-v5-` classes must move to v6 tokens. The mapping table is
`references/token-map.md`.

## Where to look

Search the whole repo, not just `.css`:

```bash
grep -rn "pf-v5\|--pf-v5-global" --include='*.css' --include='*.scss' --include='*.ts' --include='*.tsx' src/
```

Hits appear in stylesheets, inline `style={{}}` objects, `className`
strings, and test selectors.

## Variable replacement

Replace each `--pf-v5-global-*` variable with the closest **semantic**
token (`--pf-t--global--*`), chosen by *intent*, not by color value:

```css
/* before */
color: var(--pf-v5-global--Color--200);
background-color: var(--pf-v5-global--BackgroundColor--100);
border-color: var(--pf-v5-global--danger-color--100);

/* after */
color: var(--pf-t--global--text--color--subtle);
background-color: var(--pf-t--global--background--color--primary--default);
border-color: var(--pf-t--global--border--color--status--danger--default);
```

Semantic tokens adapt to the dark theme automatically — never hardcode a
hex value that a token exists for.

## Class prefix renames

`pf-v5-c-*`, `pf-v5-u-*`, `pf-v5-l-*` classes become `pf-v6-*`. For
utility classes, confirm the utility still exists in v6 before renaming;
for component classes in CSS overrides, prefer deleting the override (v6
restyled most components — the override may now fight the design system).

## React tokens package

Imports from `@patternfly/react-tokens` change names the same way:

```ts
// before
import global_spacer_md from '@patternfly/react-tokens/dist/esm/global_spacer_md';
// after
import t_global_spacer_md from '@patternfly/react-tokens/dist/esm/t_global_spacer_md';
```

## Gate

Build must pass and the grep above must return zero hits in source files
(lockfiles and build output do not count).
