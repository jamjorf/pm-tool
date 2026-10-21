# Keyboard and Palette

The web app is designed to feel like a native app with a keyboard: every read is local, every write is optimistic, and every action is reachable from the command palette so nothing is keyboard-only. Single-letter keys are suppressed while an input is focused.

Sources: [`packages/web/README.md`](https://github.com/jamjorf/pm-tool/blob/main/packages/web/README.md), the shortcut registry in [`packages/web/src/lib/shortcuts.ts`](https://github.com/jamjorf/pm-tool/blob/main/packages/web/src/lib/shortcuts.ts), palette actions in [`packages/web/src/components/palette/actions.ts`](https://github.com/jamjorf/pm-tool/blob/main/packages/web/src/components/palette/actions.ts), and the UX spec [docs/03-ux.md](https://github.com/jamjorf/pm-tool/blob/main/docs/03-ux.md).

## Keyboard map

Press `?` anywhere for the in-app cheatsheet, which is generated from the same registry.

### Global

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette (navigate, actions, bulk actions on the selection) |
| `/` | Focus search |
| `?` | Keyboard shortcuts cheatsheet |
| `c` | New item (quick create in the current project) |
| `t` | Toggle light / dark theme |
| `Esc` | Close palette, dialog or peek panel; clear the selection |

### Navigation

| Keys | Action |
|---|---|
| `g` then `h` | Go to My work (`/`) |
| `g` then `i` | Go to Inbox (`/inbox`) |
| `g` then `p` | Go to projects (`/projects`) |
| `g` then `n` | Go to notifications |

### Lists and boards

| Keys | Action |
|---|---|
| `j` / `k` | Next / previous row |
| `Enter` | Open the focused item in the peek panel |
| `x` | Toggle selection of the focused row |
| `⌘A` / `Ctrl+A` | Select all visible rows |
| `Shift+click` | Select a range |

### Item actions (focused or selected items)

| Keys | Action |
|---|---|
| `e` | Edit the title of the open item |
| `a` | Assign (palette sub-list) |
| `p` | Set priority |
| `s` | Change state (only transitions the engine allows for every target) |
| `l` | Add label |

### Specified extensions

[docs/03-ux.md §4](https://github.com/jamjorf/pm-tool/blob/main/docs/03-ux.md#4-keyboard-map) also specifies recommended extensions marked *ext* (`h` / `l` to move between board columns, `d` due date, `m` move to project, `[` / `]` previous and next item in the panel, `⌘Shift+F` focus the filter bar, `⌘S` save view, `⌘Z` undo the last transaction, `r` reply, `w` watch). These are not in the current shortcut registry; the equivalent actions (move, due date, watch) are available from the palette. Check the `?` cheatsheet for what your build has.

## Command palette

Opened with `⌘K`, built on `cmdk`. One input, several modes chosen by what you type.

| Mode | Trigger | Behaviour |
|---|---|---|
| Navigate | default | Fuzzy match over projects, views and items by key (`RATES-12`) or title; `Enter` opens. Typing an item key jumps straight to it |
| Create | `c` from any screen, or the "New item" action | Title input and type picker (project default first); `⌘Enter` creates with `createItem` in the current project and opens it; typed fields are filled in the detail panel |
| Action | an item is focused or selected | Assign, set priority, transition, add label, move to project, set due date, watch / unwatch, open full page, delete |
| Bulk | automatically when two or more rows are selected | The same actions applied to every selected item; the palette shows the count ("Assign 14 items to…") |
| Search | `/` | Deep search via `GET /api/v1/search` with snippets; local results show instantly above, server results follow |
| Help | `?` | The keyboard cheatsheet |

Results are ranked: exact key match, then items in the current project, then recently opened, then everything else. Actions that need an argument (assignee, label, project) open a second-level list in the same palette; `Esc` goes back one level, not out.

### Palette actions as registered

| Group | Action | Shortcut | Mutation |
|---|---|---|---|
| Actions | New item | `c` | `createItem` |
| Actions | New view | | `createView` |
| Actions | Toggle theme | `t` | local |
| Actions | Keyboard shortcuts | `?` | |
| Navigate | Settings, Go to My work, Go to Inbox, Search | `g h`, `g i`, `/` | |
| Selection | Assign to… | `a` | `updateItem` / `bulkUpdateItems` |
| Selection | Set priority… | `p` | `updateItem` / `bulkUpdateItems` |
| Selection | Transition →… | `s` | `transitionItem` / `bulkTransitionItems` |
| Selection | Add label… | `l` | `addLabel` per item |
| Selection | Move to project… | | `moveItem` |
| Selection | Set due date… | | `updateItem` / `bulkUpdateItems` |
| Selection | Watch / unwatch | | `watchItem` / `unwatchItem` |
| Selection | Open full page | | navigates to `/i/:itemKey` |
| Selection | Delete | | `deleteItem` (soft delete) |

"Transition →…" lists only the transitions allowed for *all* selected items; blocked ones are greyed with the failing guard.

## Bulk edit flow

1. **Select.** `x` toggles, `Shift+click` ranges, `⌘A` selects everything the current filter shows. Mutations accept up to 500 ids; beyond that the UI asks you to narrow the filter.
2. **The selection bar** appears above the view with the count and the actions (Assign, Priority, State, Label, Move, Due, Clear). Each opens the palette in bulk mode.
3. **One transaction.** `bulkUpdateItems` sends one patch for all ids in one transaction; the activity log records every item's changes under one `txn_id`, so the bulk edit is one undo unit and one webhook delivery per item.
4. **Partial success is explicit.** `bulkTransitionItems` evaluates guards per item and returns `{ok:[], failed:[{id, failures}]}`; the UI reports "12 moved, 2 skipped: RATES-4 (no assignee), RATES-9 (blocked by RATES-7)" with a link to each.
5. **Boards.** Dragging a multi-selection moves all selected cards with the same `bulkTransitionItems`. A drop between state columns picks the transition whose `to_state_id` is the target column; if several exist a small chooser appears; if none the drop is refused with the reason and the card snaps back.

## Search behaviour

| Layer | Where | Latency | Scope |
|---|---|---|---|
| Palette and view filter `contains` | local store | instant | key, title |
| Filter bar `search` field (`match` op) | local first, server FTS when the view is saved or shared and the local scan finds few results | instant to about 50 ms | key, title, description |
| Deep search (`/`, `/search`) | `GET /api/v1/search?q=&project=&limit=` | network | FTS5 over key, title, description, ranked with `bm25` and snippets; `LIKE` fallback on key/title for partial words; visibility-filtered |

Syntax is SQLite FTS5: words are ANDed, `"exact phrase"`, `a OR b`, `NOT word`, `prefix*`. Results show key, title, state chip, project and snippet. `fields` text is not in the FTS index; add a `fields.<key>` filter next to `search` when you need both.

## Inbox and item detail shortcuts in context

- **Inbox** (`g i`): `j` / `k` move, `Enter` opens the item. Rows for `state_change` and `assigned` carry the allowed transitions as buttons (same engine check). One unread row per (item, kind) updates in place as more happens.
- **Item detail** (peek panel over any view, or `/i/:itemKey` full page): `e` edits the title; the state chip shows transition buttons, enabled when allowed and disabled with the failing guard as a tooltip ("needs an assignee", "blocked by RATES-9"). Typed fields render from the type's `field_defs`; validation errors from `validateFields` appear inline.

## Accessibility basics

Real buttons and links with visible focus rings; roving `j` / `k` focus uses `aria-activedescendant`; the palette is a `dialog` with `aria-modal`; drag and drop has a keyboard path (`s` on a focused card opens the state chooser); colour is never the only signal; dark mode follows the system preference and `t` toggles it; reduced motion disables drag animations.
