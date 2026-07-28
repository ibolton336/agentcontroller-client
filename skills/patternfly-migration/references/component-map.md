# Component map: PatternFly 5 → 6

| v5 | v6 | Notes |
|---|---|---|
| `Text` / `TextContent` / `TextList` / `TextListItem` | `Content` | one component; `component` prop picks the element (`ContentVariants`) |
| `TextVariants` | `ContentVariants` | |
| `Chip` | `Label` (`variant="outline"`, `onClose`) | |
| `ChipGroup` | `LabelGroup` | toolbar filters: `ToolbarFilter` renders a `LabelGroup` |
| `Tile` | `Card` + `isSelectable`/`isClickable` | |
| `EmptyStateHeader` / `EmptyStateIcon` | props on `EmptyState` (`titleText`, `headingLevel`, `icon`) | pass the icon component itself, not an element |
| deprecated `Select` (`/deprecated`) | composable `Select` + `MenuToggle` + `SelectList`/`SelectOption` | |
| deprecated `Dropdown` (`/deprecated`) | composable `Dropdown` + `MenuToggle` + `DropdownList`/`DropdownItem` | |
| `ContextSelector`, `ApplicationLauncher` | composable `Dropdown`/`Menu` patterns | removed outright |
| `MastheadBrand` (logo link) | `MastheadLogo` | new structural `MastheadBrand` wraps it; `MastheadToggle` moves inside `MastheadMain` |
| `Toolbar` `visiblity`/`visibility` props | `visibility` (typo prop removed) | breakpoint object keys unchanged |
| `Toolbar` spacer props | `gap` / `columnGap` / `rowGap` | |
| `Button` `isActive` | `isClicked` | |
| `Modal` (v5 monolith) | `Modal` + `ModalHeader`/`ModalBody`/`ModalFooter` | v5 monolith moved to `/deprecated` |
| `Wizard` legacy (`/next` in v5) | `Wizard` (composable is the only one) | |
| `DualListSelector` tree props | composable `DualListSelector` | |
| `Popover` `headerContent` unchanged | — | no action |
| `Page` `header` prop | `masthead` prop | |
| `PageHeader` (v5 deprecated) | `Masthead` family | |

Import-path rule of thumb: anything imported from
`@patternfly/react-core/deprecated` in v5 is REMOVED in v6 — rebuild on
the composable equivalent. Anything imported from `/next` in v5 became the
default export path in v6 — drop the `/next`.
