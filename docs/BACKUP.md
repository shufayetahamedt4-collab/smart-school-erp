# BACKUP.md — what to back up and how to restore it

**Type:** operations runbook. **Nothing in this file is executable by the app.** It lists the steps
**you** run in the Google Cloud / Firebase console or with `gcloud` on your own machine.

**Date written:** 2026-10-09. **Branch:** `college-support`. **HEAD when written:** `dc0e970`.

Everything below that this repository cannot prove is marked **to be confirmed in the console**. The
repository has no script that touches a live database — every `scripts/*.mjs` verifier runs against
the local Firestore emulator by design (`scripts/lib/guard.mjs`, `requireEmulator`). This file adds
none.

---

## 1. What must be backed up

| # | Asset | Where it lives | Why it matters |
|---|-------|----------------|----------------|
| 1 | **Firestore database `smart-school-db`** | Cloud Firestore, project `amar-e-school` | The whole product: schools, students, attendance, fees, college data. Loss = total data loss. |
| 2 | **Cloud Storage bucket `amar-e-school.firebasestorage.app`** | Cloud Storage | Student photos, ID cards, attachments. Referenced by `apphosting.yaml` (`FIREBASE_STORAGE_BUCKET`) and by stored download URLs. |
| 3 | **Secrets / environment** | Google Cloud Secret Manager + the two host configs | Without these the app cannot reach Firestore at all. See [ENVIRONMENTS-AND-SECRETS.md](docs/ENVIRONMENTS-AND-SECRETS.md). |
| 4 | **Source code** | GitHub + the local checkout | `git` history is the code backup; it is not part of the data backup. |

Two facts read from the repo, worth stating plainly:

- The app selects its database by `FIRESTORE_DATABASE_ID`. In `apphosting.yaml` that value is
  `smart-school-db` (`apphosting.yaml:20-21`). Unset, it resolves to `(default)`, described in the
  code as "the rollback database" (`src/lib/firebase.ts:59-68`). So **`(default)` is a second,
  older database** — confirm in the console whether it still exists and whether it also needs a
  backup. **To be confirmed in the console.**
- The database **location** is not readable from this repo. The deployment region used in
  `firebase.json` and `apphosting.yaml` is `asia-southeast1`, which strongly suggests the database
  lives there, but the database's own location is a console fact. **To be confirmed in the console.**
  A managed backup lives in the same location as its source database.

---

## 2. Step 1 — a scheduled managed backup (daily, 30-day retention)

**Run this yourself. It requires the Blaze pricing plan and a role such as
`roles/datastore.backupSchedulesAdmin` (or `roles/datastore.owner`).**

Firestore allows **at most one daily and one weekly** schedule per database. There is no option to
pick the exact hour; backups are taken at a varying time each day. Retention may be set up to
**14 weeks (14w)**; `30d` is inside that limit.

### Option A — Google Cloud console (recommended)

1. Open **https://console.cloud.google.com** and select project **`amar-e-school`**.
2. Go to **Firestore → Databases**.
3. Find the row for database **`smart-school-db`** (confirm the name in the row).
4. In the **Scheduled backups** column, click **Edit settings** if a schedule exists, otherwise
   **View backups**.
5. Click **Edit** to open the disaster-recovery settings.
6. Tick **Daily**, set the **retention period to 30 days**, and click **Save**.
7. Under **Disaster recovery**, confirm one schedule row now shows *Daily · 30 days*.
8. (Optional) Also tick **Weekly** and pick a day — a second, independent schedule.

### Option B — gcloud on your machine

```bash
# You must be authenticated and on the right project.
gcloud config set project amar-e-school

# Create the DAILY schedule with 30-day retention, on the named database.
gcloud firestore backups schedules create \
  --database=smart-school-db \
  --recurrence=daily \
  --retention=30d

# Verify it.
gcloud firestore backups schedules list --database=smart-school-db
```

Notes:

- `--recurrence=daily` takes **no** `--day-of-week`; that flag is only for `--recurrence=weekly`.
- If gcloud rejects `--recurrence=daily`, the same command exists in beta/alpha
  (`gcloud beta firestore backups schedules create …`) — **to be confirmed in the console**.
- The Firebase CLI equivalent is
  `firebase firestore:backups:schedules:create --database smart-school-db --recurrence DAILY --retention 30d`.

### Verify the schedule exists

```bash
gcloud firestore backups schedules list --database=smart-school-db
gcloud firestore backups schedules describe --database=smart-school-db --backup-schedule=<ID>
```

Also open **Firestore → Databases → smart-school-db → Scheduled backups** and confirm a backup
appears within ~24–48 hours. **A schedule that lists is not proof a backup has run — check the
backup list.**

---

## 3. Step 2 — a manual export to Cloud Storage (the portable copy)

A managed backup can only restore within Firestore. A **managed export** writes the documents into a
Cloud Storage bucket, and that export can be imported into a **different** database or project — this
is the copy to keep off the live database.

**Before you start:** the target bucket must be in a location near the database, must not be a
Requester-Pays or Rapid bucket, and the Firestore service agent
(`service-<PROJECT_NUMBER>@gcp-sa-firestore.iam.gserviceaccount.com`) needs **Storage Admin** on it.
If the bucket is in the same project, that access exists by default. Create/confirm the export bucket
in the console first. **To be confirmed in the console.**

Cost warning from the official docs: **a managed export reads one document per exported document.**
That is billed and does not show in the console usage page. Export the whole database sparingly, or
export only the collection groups you need.

### Console

1. **Firestore → Databases** → select **`smart-school-db`**.
2. Left menu → **Import/Export** → **Export**.
3. Choose **Export entire database**.
4. Under **Choose Destination**, enter or browse to the bucket, e.g.
   `gs://amar-e-school-backups/firestore/manual-2026-10-09`.
5. Click **Export** and watch the **recent imports and exports** list for a success entry.

### gcloud

```bash
# Confirm the bucket first, then export the whole database with a dated prefix.
gcloud firestore export gs://amar-e-school-backups/firestore/manual-2026-10-09 \
  --database=smart-school-db
```

- The prefix is optional; without it Firestore creates a timestamped one.
- Add `--async` to return immediately instead of waiting.
- Set a **Cloud Storage lifecycle rule** on the export bucket (e.g. delete objects older than N
  days) so exports do not grow without bound. **To be confirmed in the console.**
- Cloud Storage versioning and/or a bucket-level backup of
  `amar-e-school.firebasestorage.app` is a separate, recommended step. Object versioning is the
  usual answer. **To be confirmed in the console.**

---

## 4. Step 3 — restore, into a SEPARATE database (never over production)

**The rule: never import or restore on top of `smart-school-db`.** Restore into a fresh named
database, inspect it, and only then decide what to do.

### Option A — restore from a managed backup

Console: **Firestore → Databases → smart-school-db → View backups → Disaster recovery**, pick the
backup, and choose **Restore**. Create a **new database name** (e.g. `smart-school-db-restore`) — do
not target the live one.

gcloud:

```bash
# Inspect the backup first.
gcloud firestore backups list --location=asia-southeast1

# Restore into a NEW database.
gcloud firestore databases restore \
  --source-backup=projects/amar-e-school/locations/asia-southeast1/backups/<BACKUP_ID> \
  --destination-database=smart-school-db-restore
```

The exact `--source-backup` path and the flag name are console/CLI facts — **to be confirmed in the
console** before you rely on them.

### Option B — import from a managed export

```bash
# Import into a NEW database. Requires that database to already exist (empty).
gcloud firestore import gs://amar-e-school-backups/firestore/manual-2026-10-09 \
  --database=smart-school-db-restore
```

An import **overwrites documents with the same id** in the target; it never deletes documents that
are absent from the export. That is another reason to import only into an empty database.

### After the restore

1. Point a **throwaway** environment at the restored database by setting `FIRESTORE_DATABASE_ID` to
   `smart-school-db-restore` **there only** — never in production. A local dev server needs
   `ALLOW_LIVE_FIRESTORE=1` before it may open a live database (`src/lib/firebase.ts:45-56`).
2. Check a few known rows: a school, its students, one attendance day, one fee row, one college
   programme. Counts should look sane, not zero.
3. Delete the restore database when finished. **To be confirmed in the console.**

---

## 5. Quarterly restore-drill checklist

Run this every quarter, on a scratch database, and record the result. A backup nobody has restored
is not a backup.

- [ ] **Schedule alive.** Console shows the Daily · 30-day schedule on `smart-school-db`, and a
      backup from the last 48 hours exists.
- [ ] **Manual export fresh.** A whole-database export from this quarter is present in the export
      bucket and its object count/size looks plausible.
- [ ] **Restore to scratch.** Restore the latest backup (or import the latest export) into a
      scratch database — never production.
- [ ] **Restore finished without error**, and the job is marked completed in the console.
- [ ] **Spot-check data.** Pick a live school id and confirm its school row, its student count, and
      its subscription row exist in the restored database.
- [ ] **Spot-check a file.** Confirm at least one Storage object (a student photo) still resolves —
      Storage is backed up separately from Firestore.
- [ ] **App against scratch.** Start a local server pointed at the scratch database (with
      `ALLOW_LIVE_FIRESTORE=1`) and sign in; the dashboard loads real-looking data.
- [ ] **Timing recorded.** Note how long the restore took — that is the real recovery time.
- [ ] **Secrets recoverable.** Confirm you can retrieve the four Secret Manager values and the two
      host configs without guessing (see ENVIRONMENTS-AND-SECRETS.md).
- [ ] **Cleanup.** Delete the scratch database and any throwaway credentials.
- [ ] **Record** the date, who ran it, the backup id, and any surprises in this file or in the
      operations log.

---

## 6. Things this repo could not verify

- The Firestore database **location** and whether `(default)` still exists — **console**.
- Whether the export bucket exists, its name, and its lifecycle rule — **console**.
- The exact cost/quotas and whether Blaze is enabled — **console**.
- Whether scheduled backups are already enabled — **console** (do not assume; check first).
- The precise `gcloud firestore databases restore` flag names on your gcloud version — **console/CLI**.
- Whether object versioning is on for the Storage bucket — **console**.

No additional Firestore composite indexes are required for the queries this app runs today. The only
real composite shape the data layer issues is `schoolId` equality plus a `date` range on
`attendance` (`src/lib/db.ts:1168-1195`), which the existing `(schoolId, date)` index already covers.
The `subscriptions` composite index declared in `firestore.indexes.json` is **not** exercised by the
current code (the shim sorts in memory, `src/lib/db.ts:1503-1509`), so it is a declared-but-unused
asset — it is left in place and its fields are now correct.
