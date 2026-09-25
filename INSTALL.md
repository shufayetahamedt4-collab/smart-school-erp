# Installing Amar E School on your own PC

Amar E School is a school ERP with four apps inside it — Platform Console, School Admin,
Teacher App and Parents App. This guide installs the whole thing **on one PC** and runs it
there. No server, no hosting bill, no developer needed after the first setup.

- [What you need](#what-you-need)
- [Windows: two double-clicks](#windows-two-double-clicks)
- [macOS and Linux](#macos-and-linux)
- [Signing in](#signing-in)
- [Where your data lives](#where-your-data-lives)
- [Letting other devices use it](#letting-other-devices-use-it)
- [Running without a Firebase account](#running-without-a-firebase-account)
- [Everyday commands](#everyday-commands)
- [Troubleshooting](#troubleshooting)
- [Updating and uninstalling](#updating-and-uninstalling)

---

## What you need

| | |
|---|---|
| **Windows** | Windows 10 or 11. Nothing needs Administrator rights. |
| **Node.js 20 or newer** | The engine the app runs on. The installer tells you the one command to get it. |
| **A Firebase project** | Free plan. This is the database — the app keeps every student, fee and result there. Roughly 3 minutes to create, once ([how](#step-2--connect-a-database)). |
| **Internet** | Needed to install, and afterwards only while the app is actually saving/reading data. |

The app itself is about 1 GB installed (mostly Node.js packages and the build).

---

## Windows: two double-clicks

### Step 1 — install

Double-click **`install.cmd`** in this folder (or the folder you unzipped it into).

It will:

1. check Node.js, and tell you exactly what to run if it is missing;
2. ask for your Firebase key **once** (see below) and write it to `.env`;
3. generate the app's own signing secret;
4. install the dependencies;
5. create the demo school, classes, students, teachers and fees;
6. build the app, so it starts in about a second from then on;
7. offer to put a shortcut on your Desktop.

Nothing is installed system-wide and it asks before every step that touches your database.

### Step 2 — connect a database

The installer asks for a **service-account key file**. Getting it takes about three minutes:

1. Open <https://console.firebase.google.com> and click **Add project** (the free plan is fine).
2. In the left menu open **Build → Firestore Database → Create database**. Pick the region
   nearest you, and accept the defaults.
3. Click the **gear icon → Project settings → Service accounts → Generate new private key**.
   A `.json` file lands in your Downloads folder.
4. Back in the installer, drag that file into the window (or paste its path) and press Enter.

That is the only time you need the Firebase console. If you already have a Firebase project
for something else, use that one — a school's data lives in its own Firestore, so it will not
mix with anything else.

### Step 3 — run it

Double-click **`start.cmd`** (or the **Amar E School** shortcut if you made one). Your browser
opens at <http://localhost:3000>. Leave the small window that appears — that is the app's log.

Close the app again with **`stop.cmd`**. Closing the browser does not stop it.

---

## macOS and Linux

Open a terminal in this folder and run:

```bash
npm ci                  # install the dependencies
npm run setup           # ask about Firebase, then seed the demo data
npm run build           # build the app (once, about a minute)
npm run app             # start it and open the browser
```

`npm run setup` expects `.env` to exist — copy `.env.example` to `.env` first and fill in the
Firebase values (the file explains each one), or place `service-account.json` in this folder and
run `node scripts/wire-env.mjs` to fill them in automatically.

Stop it again with `npm run app:stop`.

---

## Signing in

All four apps answer on the **same address** when you install it this way, and the account you
sign in with decides which app opens. The sign-in screen lists these demo logins — click one to
fill it in:

| App | Email | Password |
|---|---|---|
| School Admin (Principal) | `principal@sunrise.edu` | `School@123` |
| Teacher | `teacher@sunrise.edu` | `Teacher@123` |
| Guardian (Parent) | `guardian1@demo.com` | `Guardian@123` |
| Super Admin (platform owner) | `admin@smartschool.com` | `Admin@123` |

**Change these before real use.** Sign in as the School Admin, open *Settings → Staff* (and the
Super Admin console for the platform account), create your own accounts and deactivate the demo
ones. The demo data itself (Sunrise International School, its 16 students) can be edited or
deleted from the app.

---

## Where your data lives

In **your** Firebase project, in Cloud Firestore. Not on this PC, and not on anyone else's
server. That is deliberate: it is what lets the Parents App work on a phone while the school
admin works on a PC, and it means a nightly backup of the PC is not what protects the school's
records.

Two consequences worth knowing:

- **Deleting the folder does not delete the data.** The school's records stay in Firebase until
  you delete the project there.
- **The app needs internet while it is being used.** Firestore is a cloud database, so a
  completely offline PC can open the app but cannot load or save anything.

Your `.env` file (and the `service-account.json` you gave the installer) are keys to that
database. They are ignored by git, but do not email them around or commit them — anyone holding
them holds the school's records.

---

## Letting other devices use it

By default the app only answers on the PC it runs on (`APP_HOST=127.0.0.1` in `.env`).

To let phones and tablets on the same school network use it, open `.env`, change the line to

```
APP_HOST=0.0.0.0
```

then `stop.cmd` and `start.cmd` again, and use the PC's own address from the other device —
`http://192.168.1.50:3000`, say (run `ipconfig` to find it). Remember that the app is then
reachable by every device on that network, so use real passwords first.

The Parents App entry (`/qr`, or the invite QR on *Guardians → Parents App*) builds its links
from `APP_URL` in `.env`. Set that to the address your guardians will actually use, otherwise
printed QR codes point at `localhost`, which only means anything on the PC itself.

---

## Running without a Firebase account

For trying the app out — a demo, a classroom, a laptop with no internet project — you can run
it against Google's local Firestore emulator instead of a cloud project **and skip Firebase
entirely**:

1. Install Java (the emulator needs it) and the Firebase CLI: `npm i -g firebase-tools`.
2. In this folder: `npx firebase emulators:start --only firestore`.
3. In a second terminal add this line to `.env`:
   ```
   FIRESTORE_EMULATOR_HOST=localhost:8080
   ```
   and remove (or leave empty) the three `FIREBASE_*` credential lines — with the emulator,
   no key is needed.
4. `npm run setup` and `npm start`.

The data lives in the emulator's memory: stop it and the school is empty again. File uploads
(student photos, gallery images) need `firebase emulators:start --only firestore,storage` and
`FIREBASE_STORAGE_BUCKET` pointed at the storage emulator — everything else works.

---

## Everyday commands

| What | Windows | Any OS |
|---|---|---|
| Start the app | `start.cmd` | `npm run app` |
| Stop the app | `stop.cmd` | `npm run app:stop` |
| Re-seed demo data | `npm run setup` | `npm run setup` |
| Check the configuration | open `/api/health` | open `/api/health` |
| Start in developer mode (rebuilds on save) | `npm run dev` | `npm run dev` |
| Rebuild after changing code | `install.cmd` (say no to seeding) | `npm run build` |

`http://localhost:3000/api/health` is the quickest way to see what the app thinks of its own
configuration: it reports which settings are present and whether the database answered.

---

## Troubleshooting

**"It did not start answering on port 3000 within a minute."**
Open `app.log` in this folder — the last lines are the real error. The usual one is a database
that has not been created yet in the Firebase console.

**"Request failed" on the sign-in screen.**
The app cannot reach your database. Open `/api/health`; it names the missing setting. The most
common cause by far is a `.env` that lost its `FIREBASE_*` lines.

**"Port 3000 is already in use" / the browser shows something else.**
Another copy is already running — `stop.cmd` first. To use a different port, edit
`APP_PORT=3001` in `.env` (and `APP_URL` to match) and start again.

**The installer cannot find Node.js, but you just installed it.**
Open a new window — a freshly installed Node.js is only on PATH for windows opened afterwards.
If it still fails, re-run the Node.js installer and keep the "Add to PATH" option ticked.

**Seeding failed.**
Two usual causes: Firestore was never created in the console (Build → Firestore Database →
Create database), or the key belongs to a different project. Fix it in the console, then run
`npm run setup`. Re-running is safe — existing records are left alone.

**Forgot the address / the browser did not open.**
Open <http://localhost:3000> yourself (change the port if you set `APP_PORT`).

---

## Updating and uninstalling

**Updating** — replace the files in this folder with the new version, keeping your `.env` (and
`service-account.json`), then run `install.cmd` and answer **no** to seeding. Your data is
untouched; it lives in Firebase.

**Uninstalling** — stop the app, delete this folder, and delete the desktop shortcut. To remove
the school's records as well, delete the project in the Firebase console. Nothing was added to
Windows' registry, so there is nothing else to clean up.
