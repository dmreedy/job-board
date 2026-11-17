# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single-file Kanban board for tracking a job search (`job-tracker-v1.18.1.html`), built with vanilla HTML/CSS/JS and no build step. Two optional add-ons: `scrape-server.js` (local Node server that extracts role/company/location/salary from a job-posting URL) and `apps-script-backend.gs.txt` (Google Apps Script + Sheet backend so multiple people/devices can share one board). The tracker works fully offline; both add-ons are independent and optional.

## Commands

```bash
npm start              # run the scrape helper at http://localhost:8787
npm run test:merge     # pure-logic tests: merge/dedupe/resume handling (24 tests)
npm run test:ui        # Playwright/headless-Chromium UI regression pass (15 tests)
npm test               # both test suites
```

`test:ui` requires `npm install` first, and the Playwright browser binary via `npx playwright install chromium` (plus `npx playwright install-deps chromium`, which needs sudo, if OS shared libraries like `libglib-2.0.so.0` are missing in the environment).

Both test files take the HTML filename as an argument and default to `job-tracker-v1.18.1.html` if omitted — run `node test/merge.test.js <file>` or `node test/ui.test.js <file>` directly to test a different version file.

There is no linter or build step; `node --check` on the extracted `<script>` block is a quick syntax sanity check after editing the HTML.

### Gotchas when running or editing `test/ui.test.js`

- Don't `pkill -f chromium` to clean up a stuck browser — the pattern is broad enough to match and kill the shell process running the command, not just the browser.
- Don't `await` a `page.evaluate(...)` that itself waits on a modal/dialog promise that never resolves (e.g. a confirm dialog nothing ever dismisses) — it hangs the test run with no timeout.
- The sync backend is always mocked via `page.route`; the test runner has no real network access to external sites.

## Architecture

### Everything lives in one HTML file

`job-tracker-v1.18.1.html` contains all markup, CSS and JS inline. There is no module system — state and functions are globals inside a single `<script>` block. The test files (`test/merge.test.js`, `test/ui.test.js`) work *against this constraint*: `merge.test.js` extracts specific named functions out of the HTML's script block via regex + brace-matching and `vm.runInContext`s them in isolation, so it tests the real shipped code rather than a reimplementation. If you rename or restructure `mergeCardsAndUsersPure`, `dedupePostings`, `postingDedupeKey`, `TOMBSTONE_GC_MS` or `mergeUserResumes`, the extraction in `merge.test.js` needs to keep finding them by name.

### Sync and merge model

Sync is optional and POST-only (reads included) to keep the shared secret out of URLs/history/logs. The Apps Script backend (`apps-script-backend.gs.txt`) is a dumb storage layer — all merge/dedupe logic is client-side in the HTML:
- **Cards:** last-write-wins per card by `updatedAt`; exact ties keep the local copy.
- **Deletes are soft** (`deleted: true` tombstones), garbage-collected after ~30 days (`TOMBSTONE_GC_MS`).
- **Users:** lists are unioned.
- **Resumes:** last-write-wins per user by `resumeUpdatedAt`; a blank URL means "removed". The Apps Script also merges resumes server-side so a stale device can't wipe a link.
- **Shared Postings** are deduped by URL (ignoring tracking params) via `postingDedupeKey`/`dedupePostings`; personal columns are never deduped against each other.

See `docs/ARCHITECTURE.md` for the sync-status state machine, header/control-bar DOM structure, card geometry (`clipResizeObserver`/`applyCardGeometry`), the render-time scroll-position snapshot/restore, mobile control relocation, and the duplicate/Replace-Existing-Card flow — all details that span multiple regions of the single HTML file and aren't obvious from a top-to-bottom read.

### Columns and scope

Board columns split into shared (**Postings**, visible/claimable by everyone) and per-user personal columns (Hopper, Applied, Interviewing, Offer, Rejected, Ghosted, Expired, Discarded). The user picker controls both "who am I" (for new cards/edits) and "whose personal board am I viewing".

### Versioning convention

Every shipped change is a new `job-tracker-vX.Y.Z.html`; the previous version file is deleted (history lives in git, not in old filenames in the tree). SemVer: patch = bugfix/visual tweak, minor = new feature. When bumping the version, update in lockstep: the HTML filename, `index.html`'s redirect target, `package.json`'s `test:merge`/`test:ui` script arguments, and each test file's default path argument. `commit-message.txt` is not a changelog — it's overwritten each release with only the latest change, ending in `Version: vOLD -> vNEW (patch/minor — rationale)`.

### Working with the repo owner's terminology

- A button and its settings cog are one design unit, not two independent controls — e.g. the Sync button + cog live together in `.btn-unit#syncUnit`, Resume button + cog in `.resume-wrap`. Keep that pairing when touching header controls.
- Wording gotcha: when the repo owner says "horizontally aligned," he means vertically centered. Read alignment/spacing requests with that in mind rather than literally.

### Data format

Export/import JSON is `{version: 2, cards, users}`. `sample-job-tracker-import.json` has ~100 fictional cards for trying the board out (replaces the current board on import).

### Licensing

GPLv3-or-later (see `LICENSE`). Shipped source files (`job-tracker-v1.18.1.html`, `scrape-server.js`, `apps-script-backend.gs.txt`, `index.html`) carry a short copyright/license header — keep that header when renaming the HTML file for a new version.
