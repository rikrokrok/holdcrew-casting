# HoldCrew Casting — product plan & architecture

A commercial-casting curation tool for **production** (director / EP / PM). Import a casting
director's submissions, organise candidates into roles, run them through a selection lifecycle,
present the chosen few to the client, and book the winner into the HoldCrew Job Log.

**Status:** design/greenfield (2026-07-07). Front-end shape built + approved as a preview
(`v3.holdcrew.com/casting.html`, sample data, in-memory only). This doc is the architecture we
build the real product to. Nothing here is live yet.

---

## Product boundary (why it's its own product)

Casting is a **separate HoldCrew product**, a sibling to **HoldCrew Reels** — not a feature bolted
into either the main HoldCrew app or the Reels app. Decided 2026-07-07 (Eric). Reasons:

- **Different job:** Reels = a director's showreels sent to clients (permanent portfolio). Casting =
  audition curation for a specific shoot (ephemeral, privacy-sensitive tapes). Different lifecycle,
  different audience, different retention.
- **Independent subscription pricing:** a company can subscribe to Casting without Reels (or both).
  Casting is billed on **its own usage** (active castings / candidates / tapes / storage), so it
  needs its own service, DB, bucket, and meters.
- **No confusion:** distinct subdomain, bucket, and bill. Clear product line.

### How it stays "together with" Reels — two shared seams, not a merged app
1. **Same stack + playbook.** Built *from* the Reels template — same Node/SQLite/Wasabi/tokenized-
   viewer/upload patterns and the same dark-amber design language. We reuse a proven shape rather than
   re-inventing auth, tenancy, presigned media, or the client-share link. This is the "slim".
2. **One shared account + subscription registry.** A single place that knows "Company X exists and is
   entitled to [Reels tier] and/or [Casting tier]." Both products read it to gate access and to bill.
   This is the one identity+billing brain for the suite, and it's the same access-control/registry
   layer already on the HoldCrew roadmap (#10 subscription/access-control). Everything else is
   per-product and separate.

**Deliberately NOT done up front:** extracting a shared code *library*. That's premature abstraction.
Mirror the Reels patterns now; once both products are stable, factor the genuinely-common bits
(tenant/auth/wasabi/upload/token) into one internal module. Two lean services over shared conventions
+ one shared registry — not a monolith, not three copies of everything.

---

## Architecture

- **Service:** new repo `holdcrew-casting`, Node/Express, own systemd unit, own port (reels is :4000
  → casting e.g. :4100). Templated from `holdcrew-reels`.
- **Domain:** `<company>.casting.holdcrew.com` (mirrors `<slug>.reels.holdcrew.com`). Caddy wildcard
  `*.casting.holdcrew.com` → the service, TLS via DO DNS-01.
- **DB:** own SQLite (`data/casting.db`, better-sqlite3 WAL), `user_version` migrations (Reels idiom).
- **Media:** own Wasabi bucket **`holdcrew-casting`** (created 2026-07-07), reusing the existing
  `upshot-reels-app` sub-user (a scoped casting-bucket policy attached to it; NOT root). Keys
  `<tenant>/<job>/<candidate>/{headshot.jpg,tape.mp4}`. Config `WASABI_CASTING_BUCKET=holdcrew-casting`
  reusing the same access key already in the reels `.env`. Media is presigned GET for display; a
  generic `presignKey(key)` helper (reels' `presignSpot` hardcodes `<prefix><slug>.mp4`, casting has
  mixed extensions).
- **Auth:** per-tenant password + HMAC cookie bound to the slug (Reels #19 pattern), abstracted as a
  seam for the future shared per-user identity / subscription registry.
- **Tenants:** casting's tenants are **HoldCrew production companies** (not Reels' rep houses). Seed
  the tenants table from HoldCrew's company registry; reconcile via the shared registry so one company
  (e.g. Upshot) can hold entitlements to multiple products.

### Integration with the rest of HoldCrew
- **Entry:** a **CASTING tile on `job.html`** deep-links to `<company>.casting.holdcrew.com/?job=<suffix>`
  (like the HW tile → wrapkit). A deep-link, not a cross-origin fetch — no CORS.
- **Hold / Book → promote:** ✅ **DONE (2026-07-08).** The two commitments both POST to HoldCrew's
  existing **`v3-talent-save`** webhook (the canonical, idempotent Job Log talent writer — reused, not
  reinvented) to upsert a **TALENT row** in that job's Job Log (Department=Talent, character = the role,
  agent block + union carried across). **Hold** writes it **pending** (blank Hold Status → tentative
  talent, not yet on the call sheet); **Book** writes it **Confirmed** (which syncs to the call sheet/
  DPR). Same row (upsert by name+job), so Hold → Book just flips it to Confirmed. This is the single
  cross-system write; casting owns curation, HoldCrew owns the job record. **Auth / ONE slug:** the
  casting tenant slug **is** the HoldCrew company slug; the tenant stores just the registry token
  (`tenants.hc_token`, set by `scripts/link-holdcrew.js <slug>`). The company is taken from the
  authenticated tenant (never client input), so a commit can only ever touch that company's own Job Log.
  `job` (?job= suffix) → tab `Job_<suffix>` (job.html's rule). Backend: `src/holdcrew.js` + `POST
  /candidates/:id/{hold,book}` (shared `commitToRole`); UI: **Hold** + **Book** buttons on the drawer's
  role rows (both reachable only via their buttons — keeps held ⟺ pending-in-Job-Log, booked ⟺
  confirmed). Usage/buyout/fees still deferred (v3-talent-save has sessionCost/usageCost/days columns —
  sent blank for now, producer fills on the job side).
- **Shared registry:** access-gating + subscription/usage lives in the shared account registry (#10).

---

## Lifecycle (production v1, native commercial-casting vocabulary)

Single creative ladder — **availability (first refusal / avail) is deliberately out of v1** (it's a
Casting-Director concern, not production; may return as a CD-facing layer later — see Domain notes):

```
Shortlist → Callback → Recommend → Select → Booked      (+ Backup, + Pass as side states)
```

- **Shortlist** — landed from the submission import (cattle-call pool).
- **Callback** — invited to the callback (the 2nd session in the series).
- **Recommend** / **Backup** — post-callback tiers CDs present ("recommends and back-ups").
- **Select** — chosen to present to the client. Select-tier (and Booked) are what the client sees.
- **Booked** — won the role → promotes to the Job Log TALENT row.
- **Pass** — out.

Status is **per (candidate × role)** — a person can be Select for LEAD and Pass for FRIEND at once.

---

## Data model (SQLite; tenant- + project-scoped)

Moving to a real DB removes the flat-Sheet design's "duplicate each candidate's details per role"
tradeoff — candidate details are stored **once**; assignments reference them.

```
casting_projects        one board per (tenant, job)
  id TEXT PK, tenant TEXT, job TEXT, title TEXT, created_at, updated_at

casting_roles           the role registry, typed up front
  id TEXT PK, project_id TEXT, tenant TEXT,
  name TEXT ("LEAD"), character TEXT ("The Writer"), ord INTEGER, created_at

casting_candidates      the Cattle Call pool — one row per person, details stored ONCE
  id TEXT PK, project_id TEXT, tenant TEXT,
  name, pronouns, email, phone, agency, agent, agent_email, agent_phone,
  height, weight, hair, eyes, union,
  avail_travel, avail_fitting, avail_shoot,        -- or a JSON avail blob
  note,
  headshot_key TEXT,  tape_key TEXT,               -- Wasabi keys into holdcrew-casting
  source TEXT ('fillout-import'),  ext_ref TEXT,   -- ext_ref = importer dedupe key (name-normalised)
  created_at, updated_at

casting_assignments     the Selects board — the (candidate × role) rows
  id TEXT PK, project_id TEXT, tenant TEXT,
  candidate_id TEXT, role_id TEXT,
  status TEXT,          -- shortlist|callback|recommend|backup|select|booked|pass
  ord INTEGER,          -- manual order within a role
  updated_at,
  UNIQUE(candidate_id, role_id)

casting_sends           tokenized client-presentation link (mirrors reels `sends`)
  token TEXT PK, project_id TEXT, role_id TEXT NULL,
  min_tier TEXT DEFAULT 'select', expiry TEXT, created_at

casting_combos          named, freely-labelled assembled options (client combos)
  id TEXT PK, project_id, tenant,
  grp TEXT ('' = ungrouped, free-text cluster e.g. "Family"),
  name TEXT (free-text, "Older Family" / "Client fave" / "Option B"),
  note, ord, created_at, updated_at
casting_combo_slots     one pick per role per combo
  id TEXT PK, combo_id, tenant, role_id, candidate_id, ord,
  UNIQUE(combo_id, role_id)
```

**Combinations (Selects tab) — ✅ DONE 2026-07-08.** Build the client's alternative casts: named
options that pick one actor per role (e.g. an "Older Family" vs a "Younger Family"). **Freely named**
(name anything; optional free-text `grp` clusters them). **No structural anchor** — each combo is an
independent cast; a reused actor across combos is incidental, not enforced. **Duplicate** clones a combo
+ its slots as the fast path to a variant (swap a couple of picks). Slots are filled via a **photo
picker** — tap a slot → a face grid of that role's selects (shortlisted+) → tap a face (casting is
visual; pick by photo, not a name dropdown — Eric 2026-07-08). `POST/PUT/DELETE /combos`, `POST
/combos/:id/duplicate`, `PUT /combos/:id/slots`; UI = combo cards grouped by `grp` under the role
sections. Present-to-client per combo feeds task 7.

Front-end mapping: **Cattle Call** = `casting_candidates` for the project; **Selects** =
`casting_assignments` grouped by role. The UI's per-candidate `{role: status}` map is just that
candidate's assignment rows. Assign = insert; change status = update one field; unassign = delete.

### Room left for later (no rework)
- **CD availability layer** — add `first_refusal` / `avail` columns to `casting_assignments` (or a
  sibling) when the CD-facing version happens. The row already exists; it just gains fields.
- **Usage / buyout / fees** — booking columns on the assignment (fee, usage term/territory,
  exclusivity) captured at Book, feeding HoldCrew Talent. Deferred; home is obvious.
- **Sessions** — Callback is "session 2"; a first-class `casting_sessions` table can come later if
  multi-round scheduling is ever needed. v1 = a Callback status is enough.

---

## Client presentation (passive, by design)

A `casting_sends` token opens a **public, passive** page (reels viewer/token pattern) showing that
project/role's **Select-tier (and Booked)** candidates only: **photo + actor name + casting tape**,
nothing else, no controls, no approve/reject. Deliberate — the client doesn't self-serve edits;
changes come back to the producer off-platform. Detail-on-demand is internal only. Tapes stream from
Wasabi via short-lived presigned URLs.

---

## Media pipeline

- **Headshots** — uploaded (or imported), stored `…/headshot.jpg`, presigned GET for display.
- **Tapes** — self-tapes; uploaded via a streaming endpoint (reels `uploads.js` pattern). Open
  question: transcode-to-spec (like reels, for consistent playback) vs store-as-is (simpler, faster).
  Lean: transcode for the client-presentation tier so the client page plays cleanly; store-as-is is
  fine for internal review. Decide at the media slice.
- **Ingestion** — CSV/Fillout export (real sample in hand: 13 submissions) *upserts* by normalised
  name (`ext_ref`) so re-imports (agency resubmits, second wave) update/add without duplicating.
  Folder-per-role/candidate media ingestion matched by name is a later enhancement.

---

## Domain notes (commercial casting — researched 2026-07-07)

- **Availability = CD concern, out of production v1.** First refusal / avail / pin is how CDs hold
  talent; it maps almost exactly onto HoldCrew's crew hold chain, so if casting rolls out to CDs later
  it's a natural reuse — but production v1 doesn't own it.
- **Conflicts — not a feature.** Competing-brand exclusivity is the agent's job to screen before
  submitting; a surfaced conflict = the agent wasted our time, not a tool responsibility.
- **Usage/buyout + fees — good to have** at booking; feed HoldCrew Talent, don't duplicate.
- **Client decisioning is layered + passive** (agency creatives → creative director veto → client),
  which is exactly why the presentation page is a passive lookbook.
- **Product may roll out to CDs eventually** — a second user type; reinforces the multi-tenant +
  shared-registry design and leaving room for the availability layer.

---

## Build order (proposed)

1. **Service scaffold** — repo, Express, config, systemd, Caddy wildcard `*.casting.holdcrew.com`,
   `/api/health`, SQLite bootstrap. (Template from reels.)
2. **Tenant + auth** — tenants table (seeded from HoldCrew companies), subdomain→tenant resolve,
   per-tenant password auth; seam for shared identity.
3. **Casting schema + data layer** — the 5 tables + migrations; project/roles/candidates/assignments
   routers, tenant+project scoped (reels `reels.js` pattern; isolation tests like reels #25).
4. **Front-end** — move `casting.html` into the service, replace the DATA SEAM with the real API
   (two tabs, drawer, lifecycle already built).
5. **CSV/Fillout importer** — upsert by normalised name; ingest the real export.
6. **Media** — `WASABI_CASTING_BUCKET` + `presignKey` DONE; tape playback lightbox DONE (14 seeded).
   **Headshot upload ✅ DONE (2026-07-08):** raw-image body → `wasabi.uploadBuffer` → Wasabi key
   `<tenant>/<job>/<cand>/headshot-<rand>.<ext>` → `casting_candidates.headshot_key`; `POST
   /candidates/:id/headshot`. `photoUrl()` now serves the real headshot (presigned via `/media`)
   everywhere — cards, drawer, face picker, combos — falling back to the name-seeded placeholder. UI:
   click/drop on the drawer photo, drag-drop + 📷 button on General Call cards; unique key per upload
   busts cache + deletes the old object.
   **Tape upload ✅ DONE (2026-07-09):** `POST /candidates/:id/tape?label=` streams the video body to a
   temp file → `wasabi.uploadObject` → a `casting_media` 'tape' row (a candidate has many takes). UI: an
   **Upload tape** button + a per-take list (play / remove) in the drawer's "Casting tapes" section.
   **Bulk media import ✅ DONE (2026-07-09):** `scripts/import-media.js <tenant> <job> <folder>` — the
   SFTP path (drop the casting house's folder, run it). Matches files to candidates **by name**; two
   layouts (mixable): (A) flat files `"<Name>.jpg"` = headshot, `"<Name>.mp4"` = Take 1, `"<Name> -
   <label>.mp4"` / `"<Name> (2).mp4"` = labelled/numbered takes; (B) a sub-folder per candidate
   (`"<Name>/headshot.jpg"`, `"<Name>/*.mp4"`). Idempotent (skips existing headshot unless
   `--replace-headshot`; skips a tape whose label already exists), `--dry` preview, unmatched reported.
   **Still pending:** transcode-to-spec decision (store-as-is for now).
7. **Client presentation** — `casting_sends` token → passive public page (Select-tier).
8. **Hold / Book → promote** — ✅ **DONE (2026-07-08).** Reuses HoldCrew's `v3-talent-save` webhook
   (idempotent upsert by name+job); **one slug** (casting tenant slug = HoldCrew company slug), per-tenant
   `hc_token` linkage (`scripts/link-holdcrew.js <slug>`); Hold (pending) + Book (Confirmed) buttons in
   the drawer. Verified end-to-end against `test`/`Job_LOTTERY` (Hold=blank→Book=Confirmed on the same
   row, cleaned up). Usage/buyout/fees still deferred. See the "Hold / Book → promote" bullet above.
9. **job.html CASTING tile** — deep-link into the product. **Decoupled / do-whenever (Eric, 2026-07-07):**
   casting stands alone; the HoldCrew job-page link is available any time and is never a blocker or
   critical-path dependency. Not required for the product to be usable.
10. **Shared registry seam + usage metering** — entitlements gate + per-product usage counters (ties
    to HoldCrew #10). Access-gate reads the registry.
11. **CD-facing availability layer** — future, when/if rolled out to CDs.

---

## Decisions locked (don't relitigate)
- Separate HoldCrew **product**, sibling to Reels; kept together via shared **stack/playbook** +
  shared **account/subscription registry** only.
- Off Google: real DB (SQLite→Postgres-ready) + Wasabi, not Sheets/Drive.
- Media in a **dedicated `holdcrew-casting` Wasabi bucket** (not the reels bucket), scoped sub-user.
- Production v1 lifecycle = single creative ladder (Shortlist→Callback→Recommend→Select→Booked +
  Backup/Pass); **availability is CD-side, out of v1**.
- Client presentation = **passive** photo+name+tape, Select-tier only.
- **Slim:** build from the reels playbook; no premature shared-library extraction.

## Open questions
- Tape transcode-to-spec vs store-as-is (decide at media slice).
- Shared-registry concrete shape + how casting tenants reconcile with HoldCrew companies vs Reels
  tenants (part of #10; casting seeds from HoldCrew companies).
- Folder-based media ingestion pairing with the CSV (later).
