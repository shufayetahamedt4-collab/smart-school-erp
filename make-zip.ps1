# Build a deploy zip of this project — no secrets, no build output, no junk.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File make-zip.ps1
#
# The file list comes from git itself: everything committed + everything
# untracked but not ignored. That is exactly what a git-based deploy (Netlify,
# Firebase App Hosting) would receive, so features that were never committed
# still ship. node_modules, .next, .env, service-account.json, .firebase/,
# logs and /build never appear. The zip is then read back and checked.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = $PSScriptRoot
$out = Join-Path $root ("smart-school-erp-deploy-" + (Get-Date -Format 'yyyy-MM-dd') + ".zip")

# ---------------------------------------------------------------- 1. file list
$list = & git -C $root -c core.quotepath=false ls-files -co --exclude-standard
if ($LASTEXITCODE -ne 0 -or -not $list) { throw "git ls-files found nothing in $root" }

# Packaging artifacts and local logs stay out even when git does not ignore them.
$exclude = '^(\.zip-stage/|.*\.zip$|make-zip\.ps1$|.*\.log$)'
$files = @($list | Where-Object { $_ -notmatch $exclude })

# ------------------------------------------------------------------ 2. zip them
if (Test-Path $out) { Remove-Item $out -Force }
$zip = [IO.Compression.ZipFile]::Open($out, [IO.Compression.ZipArchiveMode]::Create)
$missing = @()
try {
  foreach ($rel in $files) {
    $full = Join-Path $root ($rel -replace '/', '\')
    # tracked-but-deleted (the /student app, for instance) has no file to add.
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { $missing += $rel; continue }
    [IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
      $zip, $full, $rel, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $zip.Dispose() }

# ------------------------------------------------------------------- 3. verify
$z = [IO.Compression.ZipFile]::OpenRead($out)
$entries = @($z.Entries | ForEach-Object { $_.FullName })
$raw = ($z.Entries | Measure-Object -Property Length -Sum).Sum
$z.Dispose()

"zip            : $out"
"entries        : $($entries.Count) shipped, $($files.Count) listed, $($missing.Count) deleted locally"
"size           : " + [math]::Round((Get-Item $out).Length / 1MB, 2) + " MB packed, " +
                   [math]::Round($raw / 1MB, 2) + " MB unpacked"

# The parts of the deploy that have to be there for the build to work.
$required = @(
  'package.json', 'package-lock.json', 'next.config.mjs', 'tsconfig.json',
  'netlify.toml', 'apphosting.yaml', 'firebase.json', 'firestore.rules',
  'storage.rules', 'firestore.indexes.json', '.env.example',
  'src/middleware.ts', 'src/lib/db.ts', 'src/lib/auth.ts', 'src/lib/sectors.ts',
  'src/lib/firebase.ts', 'src/app/layout.tsx',
  'src/app/dashboard/students/new/page.tsx', 'src/app/dashboard/branches/page.tsx',
  'src/app/dashboard/guardian-app/page.tsx', 'src/app/print/marksheet/[studentId]/page.tsx',
  'src/app/print/admission-receipt/[admissionId]/page.tsx', 'src/app/s/[slug]/page.tsx',
  'public/sw.js', 'public/manifest.json'
)
$absent = @($required | Where-Object { $entries -notcontains $_ })
"required       : $($required.Count - $absent.Count)/$($required.Count) present"
$absent | ForEach-Object { "   ! MISSING $_" }
$missing | ForEach-Object { "   - skipped (deleted on disk): $_" }

# Nothing secret, nothing rebuildable, nothing generated.
# Any .env* variant except the template — that is where live credentials sit
# (a stray .env.backup must never travel in a zip).
$bad = @($entries | Where-Object {
  $_ -match 'node_modules|service-account|^\.env(?!\.example$)|' +
            '\.firebase/|/\.git/|^\.next/|^build/|\.log$|\.zip$|^\.app\.pid$'
})
"forbidden      : $($bad.Count)"
$bad | Select-Object -First 10 | ForEach-Object { "   ! $_" }

# A quick sense of what travelled, by top folder.
"top folders    :"
$entries | ForEach-Object { if ($_ -match '/') { ($_ -split '/')[0] } else { '(root files)' } } |
  Group-Object | Sort-Object Count -Descending | ForEach-Object {
    "   " + $_.Name.PadRight(14) + " " + $_.Count
  }

if ($absent.Count -or $bad.Count) { exit 1 }
