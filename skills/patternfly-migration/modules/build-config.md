# Phase 1: Build Config

Update the dependency tree so the project resolves PatternFly 6 packages,
then restore a clean install before touching source.

## Package bumps

In `package.json`, for every `@patternfly/*` dependency present, move to
the v6-aligned major:

| Package | v5 line | v6 line |
|---|---|---|
| `@patternfly/react-core` | `^5.x` | `^6.0.0` |
| `@patternfly/react-table` | `^5.x` | `^6.0.0` |
| `@patternfly/react-icons` | `^5.x` | `^6.0.0` |
| `@patternfly/react-styles` | `^5.x` | `^6.0.0` |
| `@patternfly/react-tokens` | `^5.x` | `^6.0.0` |
| `@patternfly/react-charts` | `^7.x` | `^8.0.0` |
| `@patternfly/react-code-editor` | `^5.x` | `^6.0.0` |
| `@patternfly/patternfly` (css) | `^5.x` | `^6.0.0` |

Rules:
- Keep the caret style already used in the file.
- Do not add packages the project does not already depend on.
- If the lockfile is committed, regenerate it (`npm install`) rather than
  hand-editing.
- PatternFly 6 supports React 17 and 18; only touch the `react` /
  `react-dom` versions if the install fails on a peer-dependency conflict.

## Base CSS import

Find where the app imports the base stylesheet (commonly `index.tsx`,
`App.tsx`, or a webpack entry):

```ts
// before
import '@patternfly/react-core/dist/styles/base.css';
```

The import path is unchanged in v6, but if the app imports
`@patternfly/patternfly/patternfly.css` directly, confirm the file still
exists in the installed version and update any hashed/copied asset
references in the bundler config.

## Gate

Run `npm install` and then the project build. Expect compile errors from
renamed/removed components — that is fine at this phase **only if** the
error list is limited to identifiers addressed in later phases
(`Text`, `Chip`, `Tile`, EmptyState props, token imports). Resolve any
*other* failures (peer deps, missing packages) before proceeding.
