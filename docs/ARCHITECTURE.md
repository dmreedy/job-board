# Architecture notes

Implementation details that aren't obvious just from reading the HTML top to bottom. For the feature-level overview, see the [README](../README.md).

## Sync status

- `setSyncIndicator(state)` takes `off | pending | syncing | synced | failed`; `synced` resolves to `pending` or `off`.
- It toggles `sync-idle`, `sync-dirty`, `sync-running` and `sync-failed` on `#syncBtn`: idle is greyed, dirty is a brass pulse, running is a green spinning ring, failed is a red ring.
- The ring is an `@property --sync-a` conic-gradient mask on `::after`.
- It also drives the favicon, and sets `pillLocked` / `isSyncing`.
- On hover while failed, `showSyncTip()` / `hideSyncTip()` show an instant tooltip (`#syncTip`) with the failure reason.
- Sync requests are POST-only, with a serialized queue and backoff.

## Header

- One line made of three `.hdr-chunk` groups: the User/Viewing pickers, the Resume group plus Days/Submissions/Rejections, and `.hdr-summary` (flex-grow).
- The summary text uses `font-size: clamp(8px, .66vw, 12px)`.
- Group strokes are brass `::before` lines. On wrap, the lead-in is clipped and wrapped lines lose their stroke.

## Control bar (`.controlbar`)

- Heights are `--ctl-h:36px` and `--ctl-btn-h:34px`.
- Line 1 (`.ctl-row`), left to right: board/postings toggle, `#searchInput`, `#tagFilterInput` (hidden until tags exist), `#undoBtn`, separator, post pair (`#openPaste`, `#openAdd`) plus the Sync unit, `.ctl-subrow` (Reset Filters and Card aging, margin-left 20px), 24px brass separator, Export|Import.
- Line 2 is `#filterbar` > `#filterbarScroll`, the tag array. It is full width, capped at two pill rows (60px), scrolls vertically only, and uses `.ftag` pills at 22px tall.
- A hairline `border-bottom` on `.controlbar` separates it from the board.
- Both search inputs share one style (Inter 13px, pill shape, magnifier SVG data-URI background) via the `#searchInput, #tagFilterInput` selector. Prefer ID selectors — `.controlbar input[type=text]` has previously overridden them.
- `.filter-sep{align-self:center}` overrides flex-start, so set `align-self` explicitly when adding to that row.
- Below roughly 1500px wide, line 1 wraps: Reset Filters, Card aging and Export|Import can drop to a second row because the search boxes hit their minimum widths (`clamp(120px,18vw-160px,230px)` and `clamp(110px,9vw-20px,150px)`).

## Mobile (<=700px)

- `setupMobileRelocation()` moves the user picker, cog and sync button into `#mHeaderActions` and `#mHeaderSync`.
- Append order matters: sync, then cog. Appending after a whitespace text node previously produced a cog-before-sync bug.

## Cards

- `clipResizeObserver` sets `maxHeight = width * 1.5` for board cards; cards inside modals are exempt. Its callback defers writes one `requestAnimationFrame` to avoid a `ResizeObserver` reentrancy loop.
- `applyCardGeometry(el)` holds the clip-path/maxHeight/nameplate/dot-centering logic so `render()` can call it synchronously right after rebuilding the board (avoiding a one-frame "raw" flash), while `clipResizeObserver` still calls the same function via `requestAnimationFrame` for genuine later resizes (column drag-resize, window resize).
- `.card:last-child` has no fade mask.

## Render and scroll/flicker handling

- `render()` rebuilds the entire board on every action. It snapshots each column's `.col-body`/`.postings-grid` `scrollTop` (keyed by `data-col`) and the board's `scrollLeft` before the rebuild, and restores them after, so card moves/sorts/filter edits/toggles don't reset scroll position.

## Duplicates and Replace flow

- `findDuplicateCards` feeds `duplicateWarning`, which feeds `askChoice(...)`. That resolves to `'ok'` (Create Anyway), `'alt'` (Replace Existing Card) or `false` (cancel).
- Replace tombstones only the newest matched card (`deleted:true`, `updatedAt:Date.now()`) so the deletion syncs; it's wrapped in `pushUndoSnapshot()`, and undo restores both cards.
- `#dialogAltBtn` is a `.btn.danger`, hidden unless `altLabel` is set. The dialog widens to 480px when it's shown.

```js
let replaceId = null;
if(!editingId){
  const dupes = findDuplicateCards(data.role, data.company);
  if(dupes.length){
    const w = duplicateWarning(dupes);
    const choice = await askChoice(w.message, {okLabel:'Create Anyway', altLabel:'Replace Existing Card', cancelLabel:'Cancel', extraEl: w.extraEl, footer: w.footer});
    if(!choice) return;
    if(choice === 'alt') replaceId = w.match.id;
  }
}
pushUndoSnapshot();
if(replaceId){
  const old = cards.find(c=>c.id===replaceId);
  if(old){ old.deleted = true; old.updatedAt = Date.now(); }
}
```

## Tag filter

`renderFilterbar()` keeps the persistent `#tagFilterInput`, wired once via `dataset.wired`. It shows/hides based on `allTags().length` and rebuilds only the pill array. `tagFilterQuery` is reset by Reset Filters; a selected tag always stays listed even if it no longer matches the search.

## Data model

- Export format is `{version: 2, cards, users}`.
- Deletes are tombstones (`deleted: true`), never outright removals, so other devices can learn a card was removed during merge.
- Undo keeps the last 5 steps.

## Design decisions worth knowing before revisiting

- Per-card sync status is shown only through the Sync button's state, its hover tooltip, and the favicon — an earlier standalone "sync pill" was removed.
- Column-tint backgrounds were tried and reverted — if revisiting the color scheme, that path has already been explored and rejected.
- The tag filter's "Find tag" input lives on the control bar's first line; the old "Filter by tag" label and vertical brass stroke before the tag array were removed.
- The tag array scrolls only vertically; the search input and any label stay static above it.

## Testing pipeline

1. Extract the `<script>` block(s) and run `node --check` on them as a quick syntax sanity check.
2. `node test/merge.test.js job-tracker-vX.Y.Z.html` — pure-logic tests for merge/dedupe/resume logic, extracted and run directly from the shipped HTML (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
3. `node test/ui.test.js job-tracker-vX.Y.Z.html` — optional Playwright/headless-Chromium regression pass; the sync backend is mocked with `page.route` since the test runner has no network access to real external sites.
