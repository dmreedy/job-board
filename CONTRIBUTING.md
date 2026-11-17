# Contributing

There's no build step. The board is one HTML file; edit it directly and reload it in a browser.

## Local setup

```bash
npm install          # only needed for the optional Playwright UI test
npm start             # runs the scrape helper (scrape-server.js) at http://localhost:8787
```

## Tests

```bash
npm run test:merge    # pure-logic tests: merge/dedupe/resume handling, extracted from the shipped HTML
npm run test:ui        # optional Playwright/headless-Chromium regression pass
npm test               # both
```

`test/merge.test.js` extracts the real merge/dedupe functions out of `job-tracker-vX.Y.Z.html` and runs them directly, so it tests the shipped code rather than a copy — if a PR changes `mergeCardsAndUsersPure`, `dedupePostings`, `postingDedupeKey` or `mergeUserResumes`, this is what should catch a regression. `test/ui.test.js` drives a real browser and mocks the sync backend with `page.route` (no network access to real external sites).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for implementation notes that aren't obvious from a top-to-bottom read of the HTML.

## Screenshots

The README's screenshots (`docs/screenshots/*.png`) are generated, not hand-captured:

```bash
npm run screenshots    # requires npm install + Playwright's Chromium, see above
```

`scripts/capture-screenshots.js` loads the sample data and disables card aging before capturing (otherwise the sample dates read as old relative to whenever it's run, and decay would wash out the cards). Regenerate after any UI change that would make the current screenshots misleading.

## CI and the live demo

Every push to `main` and every PR runs `npm test` via `.github/workflows/ci.yml`. If tests pass on `main`, a second job deploys the repo root to GitHub Pages, which is what serves the live demo link in the README — pushing a broken build to `main` simply won't deploy.

## Release conventions

- **One file per version.** Every shipped change ships as a new `job-tracker-vX.Y.Z.html`; the previous version file is removed, since history lives in git (tag the commit or cut a GitHub Release if you want an easy way to grab an older version).
- **SemVer.** Patch (`x.y.Z`) is for bug fixes and visual tweaks. Minor (`x.Y.0`) is for new features.
- When bumping the version, update: the HTML filename, `index.html`'s redirect target, and the hardcoded filenames in `package.json`'s `test:merge`/`test:ui`/`screenshots` scripts and in each test/script file's default path argument.
- `commit-message.txt` is not a changelog — overwrite it fully with only the latest change, ending with `Version: vOLD -> vNEW (patch/minor — rationale)`.
- A button and its settings cog are treated as one design unit (e.g. Sync with ⚙, Resume with ⚙) — keep that pairing when touching header controls.
