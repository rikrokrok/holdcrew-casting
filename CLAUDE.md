# HoldCrew Casting — project guide

Commercial-casting curation for **production** (director / EP / PM): import a casting director's
submissions, organise candidates into roles, run the selection lifecycle, present Selects to the
client, and book the winner into the HoldCrew Job Log.

**A separate HoldCrew product, sibling to HoldCrew Reels.** Built *from* the reels playbook (same
Node/SQLite/Wasabi/tokenized-viewer/upload patterns + dark-amber design), kept together with reels
only via a shared account/subscription registry. Off Google: real DB + Wasabi, not Sheets/Drive.

> **Read [`PLAN.md`](./PLAN.md) first** — full architecture, data model, domain notes, build order,
> and locked decisions. This file is the quick orientation.

## Status (2026-07-07)
Greenfield. **Tasks 1–4 done + verified locally; not yet on the box.**
- **1 scaffold** — repo, config, SQLite schema (5 tables), tenant resolve, `/api/health`.
- **2 tenant + auth** — `src/auth.js` per-tenant password gate + HMAC cookie bound to slug;
  `scripts/onboard-tenant.js`.
- **3 data layer** — `src/casting.js` board get-or-create + roles/candidates/assignments CRUD,
  tenant-scoped. `scripts/smoke.js` = 19/19 incl. isolation.
- **4 front-end** — `public/casting.html` (the approved board) wired to the real API; served gated
  at `/casting.html?job=<suffix>`; `public/css/casting.css` self-contained; `public/login.html`.
**LIVE on the box (2026-07-07):** systemd unit `holdcrew-casting` (:4100, enabled at boot,
logs `/var/log/holdcrew-casting.log`); Caddy `*.casting.holdcrew.com` block → :4100 (wildcard cert via
DO DNS-01, issued). Tenant `upshot` onboarded (temp password). Verified over TLS at
`https://upshot.casting.holdcrew.com` — login gate, board page, API persistence round-trip; reels
unaffected. Git: committed locally (`git init`, branch `main`); **push pending** — GitHub repo
`rikrokrok/holdcrew-casting` must be created first (no `gh`/token on box; SSH key works).
**Hold / Book → Job Log (task 8) — DONE + verified 2026-07-08:** Holding or Booking a candidate into a
role writes a Talent row into that job's HoldCrew Job Log via the reused `v3-talent-save` webhook —
**Hold** = pending (blank Hold Status), **Book** = Confirmed (syncs to the call sheet); same row (upsert
by name+job). **ONE slug — the casting tenant slug IS the HoldCrew company slug.** Per-tenant token in
`tenants.hc_token`; link with `node scripts/link-holdcrew.js <slug>` (reads the token from the company
registry via `util-sheet-write`; re-run if the token rotates). Hold/Book buttons on the drawer's role
rows; `src/holdcrew.js` + `POST /candidates/:id/{hold,book}`.
⚠️ **`upshot` is unlinked until the HoldCrew company `v3` is renamed to `upshot`** (Eric's pending
rename). After the rename: `node scripts/link-holdcrew.js upshot`. `test` → HoldCrew `test` is linked
(locked tenant, for verification against `Job_LOTTERY`). Also: the live board's `?job=PWS` is a
**sample** — a real commit writes a `Job_PWS` Talent row; use a real job suffix for production.
**Combinations (Selects tab) — DONE 2026-07-08:** named, freely-labelled assembled casts (client
options) — pick one actor per role, e.g. "Older Family" vs "Younger Family". Free-text name + optional
free-text `grp` cluster; **no anchor assumption** (each combo independent); **Duplicate** clones for a
variant. Slots are filled via a **photo picker** (tap a slot → face grid of that role's selects → tap a
face; casting is visual, so pick by photo not name — Eric 2026-07-08). Tables `casting_combos` +
`casting_combo_slots`; `src/casting.js` combo routes; combo cards under the role sections on the Selects
tab. Present-to-client per combo = task 7 stub.
**Headshot upload — DONE 2026-07-08:** real headshots now show everywhere (`photoUrl()` → presigned
Wasabi via `/media`, placeholder fallback). Upload = raw image body → `wasabi.uploadBuffer` → key
`<tenant>/<job>/<cand>/headshot-<rand>.<ext>` → `headshot_key`; `POST /candidates/:id/headshot`. UI:
click/drop the drawer photo, drag-drop + 📷 on General Call cards. Verified incl. tenant isolation (403).
**Tape upload + bulk media import — DONE 2026-07-09:** `POST /candidates/:id/tape` (streamed video →
Wasabi → `casting_media` take) with an Upload-tape button + per-take list in the drawer;
`scripts/import-media.js <tenant> <job> <folder>` bulk-imports headshots/tapes matched by name (flat
`"<Name>.jpg"`/`"<Name> - <label>.mp4"` or `"<Name>/…"` folders; idempotent, `--dry`). Usage/buyout/fee
placeholder fields on the candidate (session_fee/usage_fee/usage_terms) shown in the drawer + ride along
into Book/Hold (v3-talent-save sessionCost/usageCost). Upshot re-linked to HoldCrew `upshot` (Eric
renamed v3→upshot; `v3` row lingers for an in-flight job — harmless for casting).
**NOT DONE:** CSV import UI polish, client presentation (task 7 — incl. combo lookbook), job.html tile
(task 9, decoupled), drawer single-role simplification, transcode-to-spec decision, combo review window
(building next: click a combo → review + bulk Recommend/Hold).
- Onboard more tenants: `node scripts/onboard-tenant.js <slug> "<Name>" <password>`; reset a password by
  re-running. `.env` not needed until the media slice (service runs on defaults).

## Stack / infra (target)
- Node/Express, own port **:4100** (reels is :4000). systemd unit + Caddy wildcard
  `*.casting.holdcrew.com` — NOT set up yet.
- **SQLite** (better-sqlite3, WAL) at `data/casting.db`; `user_version` migrations (reels idiom).
- **Wasabi** dedicated bucket **`holdcrew-casting`**, reusing the `upshot-reels-app` sub-user (scoped
  casting-bucket policy). Keys `<tenant>/<job>/<candidate>/{headshot.jpg,tape.mp4}`.
- Tenants = HoldCrew production companies (seeded from the company registry — task 2).

## Source map
- `src/config.js` env + settings · `src/db.js` schema + bootstrap · `src/tenant.js` subdomain→tenant +
  media-key helper · `src/ids.js` id/token minting · `src/server.js` boot + health + static.
- `public/index.html` placeholder landing (casting board arrives task 4).

## Conventions (from reels)
- Tenant isolation is the #1 risk — every data query must filter by tenant + project.
- Migrations: `CREATE TABLE IF NOT EXISTS` for base; `PRAGMA user_version` gates for later changes.
- Commit = done. End commits with the Co-Authored-By trailer.
