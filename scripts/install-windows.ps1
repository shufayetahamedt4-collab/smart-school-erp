<#
  Amar E School - one-click installer for Windows.

  Run it by double-clicking install.cmd, or from a terminal:

      powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-windows.ps1

  What it does:
    1. checks Node.js and npm are installed (and new enough)
    2. finds your Firebase credentials - from .env when it already has them,
       otherwise from a service-account JSON you point it at
    3. writes .env with a freshly generated JWT_SECRET and the app's own URL
    4. installs the dependencies (npm ci)
    5. seeds the demo school, classes, students and logins
    6. builds the app, so starting it is instant afterwards
    7. offers a desktop shortcut to start.cmd

  Every step is skippable, so re-running it is safe:
      -SkipSeed      do not touch the database
      -SkipBuild     keep the existing build
      -SkipInstall   keep the existing node_modules
      -NoShortcut    do not create a desktop shortcut
      -Yes           accept every default (no questions)
      -Port 3000     run on another port

  NOTE: this file is deliberately ASCII-only. Windows PowerShell 5.1 reads .ps1
  files with the system codepage unless they carry a UTF-8 BOM, so a box-drawing
  character here becomes a syntax error on a machine whose codepage is not UTF-8.
#>
param(
  [string]$ServiceAccount,
  [int]$Port = 0,
  [switch]$Yes,
  [switch]$SkipSeed,
  [switch]$SkipBuild,
  [switch]$SkipInstall,
  [switch]$NoShortcut
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

function Say([string]$text) { Write-Host $text }
function Head([string]$text) {
  Write-Host ""
  Write-Host "== $text " -ForegroundColor Cyan -NoNewline
  Write-Host ("=" * [Math]::Max(3, 56 - $text.Length)) -ForegroundColor DarkCyan
}
function Ok([string]$text) { Write-Host "   [ok] $text" -ForegroundColor Green }
function Warn([string]$text) { Write-Host "   [!!] $text" -ForegroundColor Yellow }
function Fail([string]$text) {
  Write-Host ""
  Write-Host "   [XX] $text" -ForegroundColor Red
  exit 1
}

# Ask a yes/no question unless -Yes was given (then take the default).
function Confirm([string]$question, [bool]$default) {
  if ($Yes) { return $default }
  $hint = if ($default) { '[Y/n]' } else { '[y/N]' }
  while ($true) {
    $answer = Read-Host "$question $hint"
    if ([string]::IsNullOrWhiteSpace($answer)) { return $default }
    if ($answer -match '^(y|yes)$') { return $true }
    if ($answer -match '^(n|no)$') { return $false }
  }
}

Say ""
Say "  +----------------------------------------------------------+"
Say "  |      Amar E School - School ERP + Parents App            |"
Say "  |      Installer for Windows                               |"
Say "  +----------------------------------------------------------+"
Say ""
Say "  This installs the app into:"
Say "    $root"
Say ""

# --------------------------------------------------------------- 1. prerequisites
Head "1/7  Checking Node.js"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Say ""
  Warn "Node.js is not installed, and it is what runs this app."
  Say ""
  Say "  Easiest fix - paste this into a terminal (PowerShell):"
  Say ""
  Say "      winget install OpenJS.NodeJS.LTS"
  Say ""
  Say "  No winget? Download the LTS installer from https://nodejs.org"
  Say "  and run it with the defaults, then start this installer again."
  Say ""
  Say "  (Chocolatey also works:  choco install nodejs-lts)"
  Fail "Node.js is required."
}

$nodeVersion = (& node -v).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) {
  Warn "Node.js $nodeVersion is too old - this app needs Node 20 or newer."
  Say "  Update with:  winget upgrade OpenJS.NodeJS.LTS"
  Say "  or install the current LTS from https://nodejs.org"
  Fail "Node.js 20+ is required."
}
Ok "Node.js $nodeVersion"

$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $npmCmd) { $npmCmd = Get-Command npm -ErrorAction SilentlyContinue }
if (-not $npmCmd) { Fail "npm was not found on PATH - reinstall Node.js from https://nodejs.org" }
Ok "npm $((& npm.cmd -v).Trim())"

# ------------------------------------------------------------------- 2. credentials
Head "2/7  Firebase credentials"

$envPath = Join-Path $root '.env'
$envExample = Join-Path $root '.env.example'
if (-not (Test-Path -LiteralPath $envPath)) {
  if (-not (Test-Path -LiteralPath $envExample)) { Fail ".env.example is missing from the project." }
  Copy-Item -LiteralPath $envExample -Destination $envPath
  Ok "Created .env from .env.example"
}

# .env is read and written as UTF-8 *without* a BOM. PowerShell 5.1's
# Get-Content/Set-Content pair decodes with the system codepage and re-encodes
# with a BOM, which turns the em-dashes in the file's comments into mojibake and
# leaves a stray \uFEFF on the first line - so both halves go through .NET with
# an explicit encoding instead.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Read-EnvText() { [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::UTF8) }
function Write-EnvText([string]$text) { [System.IO.File]::WriteAllText($envPath, $text, $utf8NoBom) }

function Read-EnvValue([string]$name) {
  $m = [regex]::Match((Read-EnvText), "(?m)^\s*$name\s*=\s*(.*)$")
  if (-not $m.Success) { return '' }
  $m.Groups[1].Value.Trim().Trim('"')
}
function Set-EnvValue([string]$name, [string]$value) {
  $text = Read-EnvText
  $pattern = "(?m)^\s*$name\s*=.*$"
  if ([regex]::IsMatch($text, $pattern)) {
    # a MatchEvaluator, because a replacement string would interpret "$"
    $text = [regex]::Replace($text, $pattern, { param($m) "$name=$value" })
  } else {
    if ($text -and -not $text.EndsWith("`n")) {
      $text += if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    }
    $text += "$name=$value" + $(if ($text.Contains("`r`n")) { "`r`n" } else { "`n" })
  }
  Write-EnvText $text
}

if ([string]::IsNullOrWhiteSpace((Read-EnvValue 'FIREBASE_PROJECT_ID'))) {
  Say ""
  Say "  The app keeps its data in a Firebase project (Firestore) - the free plan is"
  Say "  plenty for a school. One file connects it:"
  Say ""
  Say "    1. open https://console.firebase.google.com and create a project"
  Say "       (or pick one you already have)"
  Say "    2. in that project: Build -> Firestore Database -> Create database"
  Say "       (choose a region near you; production mode is fine)"
  Say "    3. click the gear -> Project settings -> Service accounts ->"
  Say "       Generate new private key  ->  a .json file is downloaded"
  Say ""
  Say "  Then give this installer that file: drag it into this window, or paste"
  Say "  its full path (usually Downloads\<project>-firebase-adminsdk-xxxx.json)."
  Say ""

  if ($ServiceAccount) {
    $saPath = $ServiceAccount.Trim('"').Trim()
  } else {
    $saPath = (Read-Host "  Path to the service-account .json").Trim('"').Trim()
  }

  if ([string]::IsNullOrWhiteSpace($saPath)) { Fail "No credentials given, so there is nothing to connect to." }
  if (-not (Test-Path -LiteralPath $saPath)) { Fail "That file does not exist: $saPath" }

  try { $sa = Get-Content -LiteralPath $saPath -Raw | ConvertFrom-Json }
  catch { Fail "That file is not valid JSON - download it again from Firebase." }
  if (-not $sa.project_id -or -not $sa.client_email -or -not $sa.private_key) {
    Fail "That JSON is missing project_id / client_email / private_key - it is not a Firebase service-account key."
  }

  # The key stays out of git (see .gitignore) and is reused on the next run.
  $saTarget = Join-Path $root 'service-account.json'
  if ((Resolve-Path -LiteralPath $saPath).Path -ne $saTarget) {
    Copy-Item -LiteralPath $saPath -Destination $saTarget -Force
  }
  Ok "Using project `"$($sa.project_id)`""

  & node (Join-Path $root 'scripts\wire-env.mjs')
  if ($LASTEXITCODE -ne 0) { Fail "Could not write the credentials into .env" }
} else {
  Ok "Already configured for project `"$(Read-EnvValue 'FIREBASE_PROJECT_ID')`" (.env)"
  Say "     (delete .env and run this again to point it at another project)"
}

$jwt = Read-EnvValue 'JWT_SECRET'
if ([string]::IsNullOrWhiteSpace($jwt) -or $jwt -eq 'change-me-to-a-long-random-string') {
  $bytes = New-Object 'System.Byte[]' 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString('x2') })
  Set-EnvValue 'JWT_SECRET' $secret
  Ok "Generated a signing secret (JWT_SECRET)"
  Say "     Keep this value - changing it later signs every user out."
} else {
  Ok "JWT_SECRET already set"
}

if ($Port -le 0) {
  $existingPort = Read-EnvValue 'APP_PORT'
  $Port = if ($existingPort -match '^\d+$') { [int]$existingPort } else { 3000 }
}
Set-EnvValue 'APP_PORT' "$Port"
if ([string]::IsNullOrWhiteSpace((Read-EnvValue 'APP_URL'))) {
  Set-EnvValue 'APP_URL' "http://localhost:$Port"
}
if ([string]::IsNullOrWhiteSpace((Read-EnvValue 'APP_HOST'))) {
  # Loopback: the app answers on this PC only. Change it to 0.0.0.0 in .env if
  # other devices on the school's network should reach it too.
  Set-EnvValue 'APP_HOST' '127.0.0.1'
}
Ok "The app will run at http://localhost:$Port (this PC only)"

# ---------------------------------------------------------------- 3. dependencies
Head "3/7  Installing the app's dependencies"
if ($SkipInstall) {
  Warn "Skipped (-SkipInstall)"
} else {
  if (Test-Path -LiteralPath (Join-Path $root 'node_modules\next')) {
    Say "  Dependencies are already present - refreshing them to match package-lock.json."
  }
  & npm.cmd ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Warn "npm ci failed - trying a plain install (this usually fixes a stale lock file)."
    & npm.cmd install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { Fail "npm could not install the dependencies. Check your internet connection and try again." }
  }
  Ok "Dependencies ready"
}

# ------------------------------------------------------------------------ 4. seed
Head "4/7  Creating the demo school and logins"
Say "  This writes sample data (one school, classes, students, teachers, fees)"
Say "  into your Firebase project. It is safe to run again - anything that"
Say "  already exists is left alone."
Say ""
$doSeed = -not $SkipSeed
if ($doSeed) { $doSeed = Confirm "  Seed the demo data now?" $true }

if (-not $doSeed) {
  Warn "Skipped - you can run it later with:  npm run setup"
} else {
  & npm.cmd run setup
  if ($LASTEXITCODE -ne 0) {
    Warn "Seeding failed. The most common cause is a Firestore database that has"
    Warn "not been created yet, or a key from a different project. Both are fixed in"
    Warn "the Firebase console; then run:  npm run setup"
    Fail "Seeding failed."
  }
  Ok "Demo data ready"
}

# ------------------------------------------------------------------ 5. build
Head "5/7  Building the app (this takes a minute)"
if ($SkipBuild) {
  Warn "Skipped (-SkipBuild)"
} else {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { Fail "The build failed. The errors above say where." }
  Ok "Built"
}

# ------------------------------------------------------------------ 6. shortcut
Head "6/7  Shortcut"
if ($NoShortcut) {
  Warn "Skipped (-NoShortcut)"
} else {
  $makeShortcut = Confirm "  Put an 'Amar E School' shortcut on your Desktop?" $true
  if ($makeShortcut) {
    try {
      $desktop = [Environment]::GetFolderPath('Desktop')
      $lnk = Join-Path $desktop 'Amar E School.lnk'
      $shell = New-Object -ComObject WScript.Shell
      $shortcut = $shell.CreateShortcut($lnk)
      $shortcut.TargetPath = (Join-Path $root 'start.cmd')
      $shortcut.WorkingDirectory = $root
      $shortcut.Description = 'Start Amar E School'
      $shortcut.Save()
      Ok "Shortcut created: $lnk"
    } catch {
      Warn "Could not create the shortcut - start the app with start.cmd instead."
    }
  } else {
    Warn "Skipped"
  }
}

# -------------------------------------------------------------------- 7. done
Head "7/7  Ready"
Say ""
Say "  Start the app:   start.cmd        (or the desktop shortcut)"
Say "  Stop the app:    stop.cmd"
Say "  Open it at:      http://localhost:$Port"
Say ""
Say "  Sign in with any of these - the sign-in screen can fill them in for you:"
Say "    School Admin   principal@sunrise.edu   School@123"
Say "    Teacher        teacher@sunrise.edu      Teacher@123"
Say "    Guardian       guardian1@demo.com       Guardian@123"
Say "    Super Admin    admin@smartschool.com    Admin@123"
Say ""
Say "  Everything you enter is stored in YOUR Firebase project, and the app runs"
Say "  entirely on this PC. To remove it: close the app, delete this folder, and"
Say "  delete the Firebase project if you do not want the data any more."
Say ""
