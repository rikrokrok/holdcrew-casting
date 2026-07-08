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
**Book → Job Log (task 8) — DONE + verified 2026-07-08:** Booking a candidate into a role writes a
confirmed Talent row into that job's HoldCrew Job Log via the reused `v3-talent-save` webhook. Per-tenant
HoldCrew linkage in `tenants.hc_slug`/`hc_token` (casting slug ≠ HoldCrew slug in general — casting
`upshot` → HoldCrew `v3`). Link a tenant: `node scripts/link-holdcrew.js <castingSlug> [hcSlug]` (reads
the token from the company registry via `util-sheet-write`; re-run if the token rotates). Book button
lives on the drawer's role rows; `src/holdcrew.js` + `POST /candidates/:id/book`. ⚠️ The live `upshot`
board's `?job=PWS` is a **sample** — a real Book there writes a `Job_PWS` Talent row into the v3/Upshot
Job Log; book against a real job suffix for production use.
**NOT DONE:** media/Wasabi (task 6 — tapes seeded, upload UI pending), CSV import UI polish, client
presentation (task 7), job.html tile (task 9, decoupled), drawer single-role simplification.
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
