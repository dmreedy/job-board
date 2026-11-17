# Job Search Ledger

A shared, single-file Kanban board for tracking a job search, built with vanilla HTML/CSS/JS and no build step. It has three parts:

| Part | File | Purpose |
|---|---|---|
| **Tracker** | `job-tracker-v1.18.1.html` | The board itself. Open it in a browser. |
| **Scrape helper** *(optional)* | `scrape-server.js` | Local Node server that pulls role, company, location and salary out of a job-posting URL. |
| **Sync backend** *(optional)* | `apps-script-backend.gs.txt` | Google Apps Script that stores cards and users in a Google Sheet, so several people (or devices) can share one board. |

Supporting files: `test/merge.test.js` and `test/ui.test.js` (tests, see [Development](#development)), `sample-job-tracker-import.json` (about 100 fictional cards to try the board with), and `commit-message.txt` (the message for the most recent change).

The tracker works fully offline and local-only. The scrape helper and the sync backend are independent add-ons.

Licensed under the [GNU GPLv3](LICENSE) — see [License](#license) below.

---

## Quick start

1. Open `job-tracker-v1.18.1.html` (the latest version file in this repo) in a browser. There is nothing to install.
2. Optional: click **Import** and choose `sample-job-tracker-import.json` to load sample data. This replaces the current board.
3. Optional: set up the [scrape helper](#scrape-helper) and the [sync backend](#sync-backend-google-sheet--apps-script) below.

Data is stored in the browser (`window.storage`, falling back to `localStorage`), so use **Export** for backups.

---

## The board

### Columns

| Column | Scope | Meaning |
|---|---|---|
| **Postings** | Shared | Jobs posted for everyone to see and claim |
| **My Hopper** | Per user | Postings you're considering |
| **Applied** | Per user | |
| **Interviewing** | Per user | |
| **Offer** | Per user | |
| **Rejected** | Per user | |
| **Ghosted** | Per user | |
| **Expired** | Per user | |
| **Discarded** | Per user | |

Each person has their own set of personal columns. Use the user picker (left of the header) to choose who you are and whose board you are viewing.

### Features

- **Board and Postings Grid views**, with card search and a tag filter. Tags are shown as a scrollable pill array.
- **Post creation** from a pasted listing or a URL, plus manual **Add**.
- **Duplicate detection** when a role and company already exist. You can **Create Anyway** or **Replace Existing Card**. Replace tombstones the old card so the deletion syncs.
- **Undo** for the last 5 changes.
- **Card aging**, an optional visual decay for cards untouched for a while (fully decayed at 30 days).
- **Summary bar** with counts, segment highlights and tooltips.
- **Resume link** per user, with a settings cog to change or remove it.
- **Export and Import** as JSON (`{version: 2, cards, users}`).
- **Mobile layout** at 700px and below, with tabs for Postings, Hopper and others.
- **Sync status** shown on the Sync button itself:

  | Button state | Meaning |
  |---|---|
  | Greyed out | Nothing pending |
  | Pulsing brass | Local changes pending |
  | Green ring circling | Sync in progress |
  | Red ring | Sync failed (hover for the reason) |

  The favicon mirrors these states.

---

## Scrape helper

`scrape-server.js` runs a tiny local HTTP server that fetches a job posting on your behalf. This avoids browser CORS limits. It then extracts what it can.

**Requirements:** Node 18 or later (it uses global `fetch`). No dependencies.

```bash
node scrape-server.js
# Scrape helper running at http://localhost:8787
```

Leave it running while you use the board. Then paste a link into the post dialog and click **Fetch**.

### How it extracts data

1. **Tier 1:** a schema.org `JobPosting` JSON-LD block. It reads role, company, location and salary.
2. **Tier 2 (fallback):** meta tags and the page title (best effort), with heuristics for sites like Built In that don't emit JSON-LD. This tier also looks for salary ranges in the page text.

### API

```
GET http://localhost:8787/scrape?url=<encoded-url>
```

Returns JSON with the extracted fields. Errors are returned as `{ "error": "..." }` with status 400 (bad or missing URL), 404 (wrong path) or 502 (the page could not be fetched).

The server answers CORS preflight requests with `Access-Control-Allow-Origin: *`. It is meant for local use, so don't expose it publicly. The port (`8787`) is hardcoded in both the server and the tracker.

If the helper isn't running, you can still paste listing text into the post dialog manually.

---

## Sync backend (Google Sheet + Apps Script)

Syncing is optional. Leave the Sync URL blank and the board stays local-only. To share a board with friends, deploy the Apps Script once and give everyone the same URL and key.

### Setup

1. Create a Google Sheet.
2. Rename the first tab to **Cards** and add this header row:

   ```
   id | role | company | location | salary | column | date | url | tags | notes | owner | sourceId | updatedAt | deleted
   ```
3. Add a second tab named **Users** with this header row:

   ```
   name | resumeUrl | resumeUpdatedAt
   ```
4. Go to **Extensions → Apps Script**, delete the starter code, and paste in the contents of `apps-script-backend.gs.txt`.
5. Change `SECRET` at the top of the script to a shared password only your group knows.
6. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**

   "Anyone" only means no Google login is needed to call the URL. Every request is still gated by `SECRET`.
7. Copy the deployment URL. In the board, click the ⚙ next to Sync. Paste the URL as the **Sync URL** and your secret as the **Sync key**, then click **Save & sync now**.

After editing the script, use **Manage deployments → Edit → New version**. Saving alone doesn't update a live deployment.

These settings are stored per browser and are not themselves synced.

### Protocol

All requests are `POST`, reads included, with the secret in the JSON body as `key`. This keeps it out of URLs, browser history and Apps Script's execution logs. `GET` returns an error explaining this.

| Request body | Effect |
|---|---|
| `{ key, action: "pull" }` | Returns `{ cards, users, resumes }` |
| `{ key, cards, users, resumes }` | Writes cards and users, and merges resumes. It is guarded by a script lock. |

A wrong key returns `{ error: "unauthorized" }`.

### Merge model

The sheet is just storage. The merge logic lives in the board:

- **Cards:** last write wins per card, compared by `updatedAt`. An exact tie keeps the local copy.
- **Deletes are soft.** A card with `deleted: true` tells other devices it was removed. Tombstones are garbage-collected after about 30 days.
- **Users:** the lists are unioned.
- **Resumes:** last write wins per user, compared by `resumeUpdatedAt`. A blank URL means "link removed". The script also merges resumes server-side so a stale device can't wipe someone's link.
- **Shared Postings** are de-duplicated by URL, ignoring tracking parameters. Personal cards are never de-duplicated against each other.

---

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and release conventions, and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for implementation notes.

### Tests

`test/merge.test.js` extracts the real merge and dedupe functions from the HTML and runs them, so it tests the shipped code rather than a copy. It has 24 tests covering conflict resolution, tombstones, garbage collection, dedupe and resumes. `test/ui.test.js` is an optional Playwright/headless-Chromium regression pass over the live UI.

```bash
npm run test:merge    # node test/merge.test.js job-tracker-v1.18.1.html
npm run test:ui        # optional, requires `npm install` first (Playwright)
```

### Conventions

- **One file per version.** Every shipped change is a new `job-tracker-vX.Y.Z.html`, and the previous file is removed because history lives in git.
- **SemVer.** Patch is for bug fixes and visual tweaks. Minor is for new features.
- **`commit-message.txt`** describes only the latest change and ends with `Version: vOLD -> vNEW (patch/minor — rationale)`.
- A button and its settings cog are treated as one design unit (Sync with ⚙, Resume with ⚙).

### Known limitations

- Below roughly 1500px wide, the first control-bar line wraps. Reset Filters, Card aging and Export|Import can drop to a second row.
- The scrape helper is best effort. Sites that block server-side requests or render postings client-side may return little.
- The Apps Script shared key is a shared password, not per-user authentication. Treat the deployment URL and key as private.

---

## License

Copyright (C) 2026 Derek Reedy.

Licensed under the [GNU General Public License v3.0 or later](LICENSE). This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY — see the LICENSE file for the full terms.
