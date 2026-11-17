# Makes the release notes for a new Windows + Android release, with the file fingerprints and a Defender scan:
#   powershell -ExecutionPolicy Bypass -File tools\release-notes.ps1 -Version 1.4.0 -Notes "One line about what changed"
#
# Run it AFTER build-installer.ps1 (which puts the installer in .\installer) and after the Android app is built (public\Roger.apk).
# It writes release-notes.md next to this repo's README. Then:
#   1) upload the installer files to a GitHub release (tag v<Version>)  2) upload them to virustotal.com
#   3) paste the VirusTotal links into release-notes.md  4) paste release-notes.md into the GitHub release text.
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Notes = 'What changed in this version (one line)'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$exe = Join-Path $root "installer\Roger-Setup-$Version.exe"
$blockmap = "$exe.blockmap"
$latest = Join-Path $root 'installer\latest.yml'
$apk = Join-Path $root 'public\Roger.apk'
foreach ($f in $exe, $blockmap, $latest, $apk) { if (-not (Test-Path $f)) { throw "Missing: $f (build first)" } }

$exeSha = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower()
$apkSha = (Get-FileHash $apk -Algorithm SHA256).Hash.ToLower()
$apkVer = ''
try { $apkVer = (Get-Content (Join-Path $root 'public\android-version.json') -Raw | ConvertFrom-Json).versionName } catch {}

# Windows Defender scan (detect only). Skipped quietly if Defender isn't available on this PC.
function Scan($path) {
  $mp = Get-ChildItem 'C:\ProgramData\Microsoft\Windows Defender\Platform' -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
  if (-not $mp) { return 'not scanned (Defender not found)' }
  $out = & (Join-Path $mp.FullName 'MpCmdRun.exe') -Scan -ScanType 3 -File $path -DisableRemediation 2>&1 | Out-String
  if ($out -match 'found no threats') { return 'clean' }
  if ($out -match 'found') { return 'THREAT REPORTED - do not publish; investigate' }
  return 'not scanned'
}
$exeScan = Scan $exe
$apkScan = Scan $apk
if ($exeScan -like 'THREAT*' -or $apkScan -like 'THREAT*') { Write-Warning "Defender reported something. Do not publish until you know why." }
$date = Get-Date -Format 'yyyy-MM-dd'

@"
## Roger $Version

$Notes

### Verify your download
| File | SHA-256 |
|---|---|
| ``Roger-Setup-$Version.exe`` (Windows) | ``$exeSha`` |
| ``Roger.apk`` $apkVer (Android; also at /Roger.apk on the server) | ``$apkSha`` |

PowerShell:  ``Get-FileHash .\Roger-Setup-$Version.exe -Algorithm SHA256``   (it must match the line above)

- Windows Defender scan of these exact files on $date : installer **$exeScan**, APK **$apkScan**.
- VirusTotal scan of the Windows installer: **<paste the VirusTotal link here>**
- VirusTotal scan of the Android APK: **<paste the VirusTotal link here>**
- Roger is open source (MIT). It needs no admin rights, has no keyboard hooks, no ads and no trackers.
  Read ``PRIVACY-AND-SECURITY.md`` for exactly what it does and which servers it talks to, and ``SECURITY.md`` for the Android signing key fingerprint.
- Windows may warn about a new, unsigned program ("Windows protected your PC"): that is about reputation, not behaviour. Choose **More info > Run anyway**.
  Android may show a Play Protect notice: choose **Install anyway**. Never turn off your antivirus for this.
- Already installed? The Windows app and the Android app both update themselves when you open them.
"@ | Set-Content (Join-Path $root 'release-notes.md') -Encoding utf8

Write-Host ""
Write-Host "Installer SHA-256 : $exeSha   (Defender: $exeScan)"
Write-Host "APK SHA-256       : $apkSha   (Defender: $apkScan)"
Write-Host "Wrote             : release-notes.md  (paste into the GitHub release, after adding the VirusTotal links)"
