# Token map: v5 global variables → v6 semantic tokens

Choose by intent. When several v5 usages map to one v6 token, that is the
point — v6 collapses presentational variables into semantic roles.

## Text

| v5 | v6 |
|---|---|
| `--pf-v5-global--Color--100` | `--pf-t--global--text--color--regular` |
| `--pf-v5-global--Color--200` | `--pf-t--global--text--color--subtle` |
| `--pf-v5-global--Color--light-100` (on dark) | `--pf-t--global--text--color--inverse` |
| `--pf-v5-global--link--Color` | `--pf-t--global--text--color--link--default` |
| `--pf-v5-global--link--Color--hover` | `--pf-t--global--text--color--link--hover` |

## Background

| v5 | v6 |
|---|---|
| `--pf-v5-global--BackgroundColor--100` | `--pf-t--global--background--color--primary--default` |
| `--pf-v5-global--BackgroundColor--200` | `--pf-t--global--background--color--secondary--default` |
| `--pf-v5-global--BackgroundColor--dark-100` | `--pf-t--global--background--color--inverse--default` |

## Status

| v5 | v6 |
|---|---|
| `--pf-v5-global--danger-color--100` | `--pf-t--global--icon--color--status--danger--default` / `--pf-t--global--border--color--status--danger--default` (pick by property) |
| `--pf-v5-global--success-color--100` | `--pf-t--global--icon--color--status--success--default` |
| `--pf-v5-global--warning-color--100` | `--pf-t--global--icon--color--status--warning--default` |
| `--pf-v5-global--info-color--100` | `--pf-t--global--icon--color--status--info--default` |

## Spacing (names carry over)

| v5 | v6 |
|---|---|
| `--pf-v5-global--spacer--xs..4xl` | `--pf-t--global--spacer--xs..4xl` |

## Border / radius / shadow

| v5 | v6 |
|---|---|
| `--pf-v5-global--BorderColor--100` | `--pf-t--global--border--color--default` |
| `--pf-v5-global--BorderWidth--sm` | `--pf-t--global--border--width--regular` |
| `--pf-v5-global--BorderRadius--sm` | `--pf-t--global--border--radius--small` |
| `--pf-v5-global--BoxShadow--sm` | `--pf-t--global--box-shadow--sm` |

## Font

| v5 | v6 |
|---|---|
| `--pf-v5-global--FontFamily--text` | `--pf-t--global--font--family--body` |
| `--pf-v5-global--FontFamily--monospace` | `--pf-t--global--font--family--mono` |
| `--pf-v5-global--FontSize--sm/md/lg` | `--pf-t--global--font--size--body--sm/default/lg` |
| `--pf-v5-global--FontWeight--bold` | `--pf-t--global--font--weight--body--bold` |

A v5 variable with no row here: consult the token documentation page
(guide_url in SKILL.md metadata) or pick the nearest semantic role; do not
inline a literal color.
