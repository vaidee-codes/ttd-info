# Information publishing

Run `node scripts/build-information.mjs` after editing content, then `node scripts/build-information.mjs --check` and `npm test`. Generated HTML and the sitemap are committed so deployment remains a plain static deployment. No package, API, environment, or deployment configuration changes are required.

`information.mjs` contains curated events, sevas, glossary definitions, counter references and source metadata. `guides.json` preserves the eight existing guide articles and anchors. Its `body` values are trusted, locally reviewed HTML, never remote input. The old unsourced October quota-release paragraph was replaced with evergreen instructions to check the official release notice.

## Source inventory — reviewed 10 September 2026

| Area | Reference | Incorporated | Verification / exclusions |
| --- | --- | --- | --- |
| Events | https://thetirumalaverse.in/ | Date-led agenda, temple taxonomy, Brahmotsavam topics, Tiruchanoor processions | 16 entries from linked official TTD announcements: September annual festival, October Navarathri range, September Tiruchanoor processions. Other reference dates and recurring events omitted until officially verified. Selecting other temples explicitly shows no published entries. |
| Sevas | https://thetirumalaverse.in/sevas | Daily sequence, weekday timetable, weekly and periodical groupings | Daily and weekly content checked against TTD DailySevas.aspx and WeeklySevas.aspx. Do not treat these reference schedules as today's operations. The weekday timetable follows the published TTD clock windows; unresolved public-booking status is called out. |
| Tokens | https://thetirumalaverse.in/tokens | SSD/DD distinction, identification, counter locations, walking and reporting considerations | TTD's homepage is linked for its current SSD slot/balance notice. Tirumala Info's independent SSD/DD status page is linked as a live community report. TTD Info displays neither feed's counts; verify both sources and with staff before travelling. |
| Glossary | https://thetirumalaverse.in/glossary | 29 short definitions covering planning, rituals, processions and festivals | Original concise explanations; source per entry. Does not reproduce the reference's long historical essays, religious narratives, images, claimed magazine quotations, or full 81-entry encyclopedia. |

Exact official source URLs are stored alongside `sources` in `information.mjs` and rendered beside the relevant entries. Review dates describe an editorial review, not a guarantee of current operations. The production origin `https://ttd-info.vercel.app` was confirmed against the existing API canonical-origin constant and the live homepage's HTTP 200 response.

The daily timetable reproduces the weekday clock windows published by TTD's DailySevas page. Weekly reporting and seva times and periodical festival timings come from TTD's WeeklySevas and AnnualSevas pages; annual notices can revise them. A time shown here is a reference schedule, never a promise of entry or availability.

## Updating safely

- Add only sourced civil dates (`YYYY-MM-DD`) in Asia/Kolkata. Do not generate annual recurrences from last year's dates. Optional `endDate` must be on or after the start date.
- Keep stable IDs for incoming links. Update source links and the review date only after review. Add a dated official notice for schedule changes; exclude unresolved event dates.
- Update the events coverage note when adding new months or temples. The interactive view defaults to the visitor's current India month; Show all dates reveals the archive. Without JavaScript, all dated entries remain readable.
- Search and filtering are local only. No analytics, external scripts, new backend, notifications, API keys or scraper is installed.
- If enabling live data later, design and verify that integration separately. Missing observations must never imply availability or zero tokens.

## Release boundary

Only stage the generated six HTML pages, sitemap, information styles/scripts, content directory, generator and information/navigation tests for this change. Existing API, README, package and environment edits predate this work and must not be included. Pass files, demos, shared CSS and deployment configuration must remain byte-for-byte unchanged from the working-tree baseline.

Preview locally with clean-URL support, inspect mobile and desktop layouts and run the existing repository deployment gate before any production release. No production deployment is part of the local implementation. A rollback reverts only these information files. Vercel CLI reported 59.1.3 during inspection; upgrade with `npm i -g vercel@latest` before deployment work for compatibility with the current CLI.

## Verification recorded for this implementation

- `npm ci --ignore-scripts` installed the existing lockfile dependency without changing package files. `npm test`: 31 passing tests, including the existing checkout/licence tests.
- Generator freshness, internal routes, fragment targets, source records, event ranges, India midnight boundaries, empty searches, and asset isolation are covered by tests.
- Browser: event temple filtering returned the five Tiruchanoor entries; November returned the explicit empty state. Glossary empty search and alphabet recovery worked. Guide search found accommodation; keyboard Tab exposed the skip link with a visible outline.
- Browser: all six information pages, Pass and Demos had a 390px document width with no page-level horizontal overflow. A fixed-width iframe was used because the browser viewport override did not apply. Guide tables may scroll within their own container.
- Browser with scripts blocked: all 12 guide-directory cards, 16 event entries, and 29 glossary entries remained rendered; enhancement controls stayed hidden.
- Pass desktop screenshot matched the pre-change screenshot byte-for-byte. The revenue HTML, shared CSS, APIs and deployment configuration matched their pre-change working-tree hashes. All three Vimeo embeds loaded their titles, thumbnails and Play controls. No checkout or live payment was initiated.
- All three supplied Maps links returned HTTP 200 and resolved to the named Srinivasam, Vishnu Nivasam and Bhudevi destinations. This verifies the destination, not counter operating status.
- No production deployment was made. Live backend behavior on a deployed preview and production deployment gates remain release checks; the local static preview intentionally has no payment backend.
