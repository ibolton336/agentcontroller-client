# Phase 3: Components

Apply the component API changes the codemods cannot complete. Work
file-by-file through the checklist recorded in Phase 2. The full rename
table is `references/component-map.md`; the highest-traffic changes:

## Text family → Content

`Text`, `TextContent`, `TextList`, `TextListItem` are gone; one `Content`
component with a `component` prop replaces them all.

```tsx
// before
import { Text, TextContent, TextVariants } from '@patternfly/react-core';
<TextContent>
  <Text component={TextVariants.h2}>Runs</Text>
  <Text component={TextVariants.p}>Recent activity</Text>
</TextContent>

// after
import { Content, ContentVariants } from '@patternfly/react-core';
<Content>
  <Content component={ContentVariants.h2}>Runs</Content>
  <Content component={ContentVariants.p}>Recent activity</Content>
</Content>
```

## Chip → Label

`Chip`/`ChipGroup` are removed; use `Label`/`LabelGroup` with `onClose`
for dismissable chips. Filter-chip toolbars use `ToolbarFilter` +
`LabelGroup`.

```tsx
// before
<ChipGroup>{names.map((n) => <Chip key={n} onClick={() => remove(n)}>{n}</Chip>)}</ChipGroup>

// after
<LabelGroup>{names.map((n) => <Label key={n} variant="outline" onClose={() => remove(n)}>{n}</Label>)}</LabelGroup>
```

## EmptyState composition

The header/icon/title composition collapsed into props on `EmptyState`:

```tsx
// before
<EmptyState>
  <EmptyStateHeader titleText="No runs" icon={<EmptyStateIcon icon={CubesIcon} />} headingLevel="h3" />
  <EmptyStateBody>Create one.</EmptyStateBody>
</EmptyState>

// after
<EmptyState titleText="No runs" headingLevel="h3" icon={CubesIcon}>
  <EmptyStateBody>Create one.</EmptyStateBody>
</EmptyState>
```

## Other removals

- `Tile` → `Card` with `isSelectable`/`isClickable`.
- Deprecated (`/deprecated`-path) `Select`, `Dropdown`, `ContextSelector`,
  `ApplicationLauncher` → the composable `Select`/`Dropdown`/`MenuToggle`
  family. Rebuild each instance following the pattern in
  `references/component-map.md`.
- `Masthead`: `MastheadBrand` renamed `MastheadLogo`; a new structural
  `MastheadBrand` wraps it inside `MastheadMain`; toggles moved.
- `Toolbar`: `visibility`/`visiblity` breakpoint props renamed; spacer
  props consolidated as `gap`/`columnGap`/`rowGap`.

## Gate

Run the build after each file (or tight group of files). At phase end the
build must pass with zero references to removed components.
