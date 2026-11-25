# Builds the Windows installer and the files the auto-updater needs.
# Usage:  .\build-installer.ps1 -ServerUrl https://your-app.onrender.com
# (Needs Node.js on THIS machine only. Players just run the finished installer.)
#
# Output in .\installer :
#   Roger-Setup-<version>.exe          share this with players (first install)
#   Roger-Setup-<version>.exe.blockmap + latest.yml    attach all three to a GitHub Release so installed apps update themselves
param([Parameter(Mandatory = $true)][string]$ServerUrl)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'desktop'
$work = 'C:\bhr\desktop'      # short path: the NSIS compiler breaks on very long folder paths

# Point the app at the hosted server.
(@{ serverUrl = $ServerUrl.TrimEnd('/') } | ConvertTo-Json) | Set-Content (Join-Path $src 'config.json') -Encoding ascii

New-Item -ItemType Directory -Force $work | Out-Null
# A test copy running from the build folder locks its files and makes the build fail: close it first.
Get-Process -Name Roger -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$work\dist\*" } | Stop-Process -Force
Start-Sleep -Seconds 3
# (node_modules is left out on purpose: the build folder keeps its own freshly installed copy, so an old local copy can never overwrite it.)
robocopy $src $work /E /XD (Join-Path $src 'dist') (Join-Path $src 'node_modules') /NFL /NDL /NJH /NJS /NP | Out-Null

Push-Location $work
try {
  # Always make sure the installed tools match package.json (so the build never silently uses an old Electron).
  $ErrorActionPreference = 'Continue'      # npm prints harmless warnings on stderr
  npm install --no-audit --no-fund
  $installCode = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  if ($installCode -ne 0) { throw "npm install failed, so the installer was not built." }
  # Electron's installer script is sometimes skipped by npm; make sure the runtime exists.
  if (-not (Test-Path node_modules\electron\dist\electron.exe)) { $ErrorActionPreference = 'Continue'; npm rebuild electron; $ErrorActionPreference = 'Stop' }
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  $started = Get-Date
  npm run dist
  if ($LASTEXITCODE -ne 0) { throw "The installer build failed (see the messages above). Nothing was published or copied." }
} finally { Pop-Location }

$out = Join-Path $root 'installer'
New-Item -ItemType Directory -Force $out | Out-Null
$dist = Join-Path $work 'dist'
$built = Get-ChildItem $dist -Filter 'Roger-Setup-*.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $built -or $built.LastWriteTime -lt $started) { throw "No freshly built installer was found, so nothing was copied." }
Get-ChildItem $out -File | Remove-Item -Force
Copy-Item $built.FullName $out -Force
Copy-Item "$($built.FullName).blockmap" $out -Force
Copy-Item (Join-Path $dist 'latest.yml') $out -Force
Write-Host "Done. Files in $out :"
Get-ChildItem $out | ForEach-Object { Write-Host "  $($_.Name)" }
