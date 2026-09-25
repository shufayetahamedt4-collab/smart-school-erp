# Amar E School — native apps (Android)

Native Android shells around two of the sector web apps. A shell exists for the
things a home-screen web app cannot do well:

- a real app icon and name in the launcher and the store,
- a fullscreen window with no browser chrome,
- file uploads from the gallery/camera (homework, leave applications),
- camera access for QR scanning,
- **Deep/App Links** — a printed link or QR opens the app directly, instead of a
  browser.

The web apps are the product. Keep these shells thin: anything the software can
do in the web app belongs there, not here.

## The three modules

| Module | What it is | Application ID | Starts at |
|---|---|---|---|
| `shell/` | The shared shell. Fullscreen WebView, back handling, uploads, camera, external-link escape, App Links, offline screen. No app of its own. | — (library) | — |
| `app/` | **Parents App** — guardians (and the child on the guardian's device) | `com.amareeschool.parents` | `https://parents.<domain>` |
| `teacher/` | **Teacher App** — teachers and staff | `com.amareeschool.teachers` | `https://teacher.<domain>` |

Each app module is ~50 lines: it states the three deployment facts that actually
differ — the origin it loads, its user-agent suffix, its brand colour — and the
shared `NativeShellActivity` does everything else. The shells are deliberately
**not** copies: the user-agent suffix is a contract with the web app (it is what
suppresses "install the app" from inside the app), and a duplicated contract is
exactly what silently drifts out of sync.

There are **two separate apps, not one app in two modes**, because the product is
split by sector: a teacher installs the Teacher App and never sees a family-only
screen. One Gradle build produces both.

## What they are not

- **They are not separate UIs.** The screens are the web apps' own pages.
- **They still ask the user to confirm the install.** Android requires an
  explicit confirmation for every install, from the Play Store or otherwise — no
  platform allows a QR code (or anything else) to install an app silently. Native
  removes the *browser* step, not the *confirm* step.
- **One APK per app serves every school.** The product is multi-tenant, so the
  school is chosen by the link that opened the app, or by the account that signs
  in. Per-school icons/names would mean a separate listing per school.

## Build

The project has **no third-party dependencies** (framework APIs only), so it
builds without network access.

```bash
cd android

# both apps, pointed at your deployment
./gradlew assembleDebug \
  -PparentsOrigin=https://parents.yourdomain.com \
  -PteacherOrigin=https://teacher.yourdomain.com

# one app only
./gradlew :teacher:assembleDebug -PteacherOrigin=https://teacher.yourdomain.com

# installable APKs
#   app/build/outputs/apk/debug/app-debug.apk       Parents App
#   teacher/build/outputs/apk/debug/teacher-debug.apk  Teacher App
```

With no `-P` flags the build uses the defaults in `gradle.properties`
(`https://parents.example.com`, `https://teacher.example.com`).

Requires a JDK 17+ and an Android SDK. Android Studio creates `local.properties`
itself; from the command line set `ANDROID_HOME`, or add:

```
sdk.dir=C\:\\path\\to\\Android\\Sdk
```

The Android Gradle Plugin is pinned in `build.gradle`. It is declared on the
buildscript classpath (not via `plugins { }`) so the build also works from a
populated Gradle cache with `--offline`.

Launcher icons are generated, not hand-drawn — one icon per app in its own brand
colour, at all five densities. Regenerate after changing a colour or glyph:

```bash
node ../scripts/generate-android-icons.mjs
```

## Make a link open the app

Do this **per app**, because each app claims its own host.

1. Build with that app's host — e.g. `-PteacherOrigin=https://teacher.yourdomain.com`.
   The host goes into that app's App Links intent filter.
2. Publish the signing certificate fingerprint so Android can verify the link:

   ```
   ANDROID_APP_PACKAGE=com.amareeschool.parents
   ANDROID_CERT_SHA256=<SHA-256 of the Parents App signing certificate>

   ANDROID_TEACHER_APP_PACKAGE=com.amareeschool.teachers
   ANDROID_TEACHER_CERT_SHA256=<SHA-256 of the Teacher App signing certificate>
   ```

   Both are served from one `/.well-known/assetlinks.json` (see
   `src/app/.well-known/assetlinks.json/route.ts`) — one entry per app. Use the
   **Play App Signing** fingerprint once published, not the upload key. Verify:

   ```bash
   curl -s https://parents.yourdomain.com/.well-known/assetlinks.json
   # and, on a device:
   adb shell pm verify-app-links --re-verify com.amareeschool.teachers
   adb shell pm get-app-links com.amareeschool.teachers
   ```

3. Optional: set `PLAY_STORE_URL` so a school's entry page offers
   "Get it from Google Play" to Android visitors who don't have the app yet.

Until step 2 is done the link still works — it just opens the browser, where the
user can install the web app instead. That is the correct fallback, not a bug.

## Release

```bash
# separate keystores are not required, but separate listings are
keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 2048 \
  -validity 10000 -alias amareeschool

./gradlew bundleRelease \
  -PparentsOrigin=https://parents.yourdomain.com \
  -PteacherOrigin=https://teacher.yourdomain.com
# app/build/outputs/bundle/release/app-release.aab        → Parents App listing
# teacher/build/outputs/bundle/release/teacher-release.aab → Teacher App listing
```

Signing keys and `keystore.properties` are gitignored — never commit them. Prefer
Play App Signing and keep the upload key offline.

Publishing needs, from you (not from this repo):

- a Google Play developer account,
- a store listing per app (title, description, screenshots, icon),
- a privacy policy URL — these apps handle children's data, so this is mandatory,
- the data-safety declaration,
- review, which typically takes days for a new account.

## Testing on a real phone without publishing

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r teacher/build/outputs/apk/debug/teacher-debug.apk

# open either app straight at its host
adb shell am start -a android.intent.action.VIEW -d "https://teacher.yourdomain.com"
```

Note: the release build forbids cleartext HTTP
(`res/xml/network_security_config.xml`), so a phone cannot talk to a plain
`http://` dev server. Test against an HTTPS deployment or a tunnel. **Debug builds
are exempt on purpose**: each module's `src/debug/` adds an `http` intent filter
for its own dev host (e.g. `http://teacher.localhost:3000`) and permits cleartext.

## How each app knows it *is* the app

Each `MainActivity` appends its own suffix to the WebView user agent. The web app
uses that to skip every "install the app" prompt when it is already inside the
app (`src/components/InstallApp.tsx` → `NATIVE_SHELL_UA`, and the server-side
check in `src/app/s/[slug]/page.tsx`).

| App | User-agent suffix |
|---|---|
| Parents App | `AmarESchoolParents/1.0` |
| Teacher App | `AmarESchoolTeachers/1.0` |

If you change a suffix, change it in the app module **and** in the web app's
regex — they are two halves of one contract.
