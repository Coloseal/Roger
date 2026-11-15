# Builds the Windows installer: installer\Roger Setup.exe
# Usage:  .\build-installer.ps1 -ServerUrl https://your-app.onrender.com
# (Needs Node.js on THIS machine only. Players just run the finished installer.)
param([Parameter(Mandatory = $true)][string]$ServerUrl)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$src = Join-Path $root 'desktop'
$work = 'C:\bhr\desktop'      # short path: the NSIS compiler breaks on very long folder paths

# Point the app at the hosted server.
(@{ serverUrl = $ServerUrl.TrimEnd('/') } | ConvertTo-Json) | Set-Content (Join-Path $src 'config.json') -Encoding ascii

New-Item -ItemType Directory -Force $work | Out-Null
robocopy $src $work /E /XD (Join-Path $src 'dist') /NFL /NDL /NJH /NJS /NP | Out-Null

Push-Location $work
try {
  if (-not (Test-Path node_modules\electron-builder)) { npm install }
  # Electron's installer script is sometimes skipped by npm; make sure the runtime exists.
  if (-not (Test-Path node_modules\electron\dist\electron.exe)) { npm rebuild electron }
  $env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'
  npm run dist
} finally { Pop-Location }

$out = Join-Path $root 'installer'
New-Item -ItemType Directory -Force $out | Out-Null
Copy-Item (Join-Path $work 'dist\Roger Setup *.exe') (Join-Path $out 'Roger Setup.exe') -Force
Write-Host "Done: $out\Roger Setup.exe"
