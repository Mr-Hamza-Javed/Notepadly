# Builds a release on this PC, much faster than the GitHub workflow.
#
#   powershell -ExecutionPolicy Bypass -File scripts\build-release.ps1 0.1.2
#
# Output in release\<version>\:
#   Notepadly_<version>_x64-setup.exe       installer
#   Notepadly_<version>_x64-portable.zip    no-install copy
#   Notepadly_<version>_x64-setup.exe.sig   update signature   (only with the signing key)
#   latest.json                             auto-update feed    (only with the signing key)
#
# The version is set only for this build; the files in the repo are put back afterwards.
# The signing key is read from %USERPROFILE%\.tauri (notepadly-updater.key and .password).
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') { throw "Not a version like 1.2.3: $Version" }
$repo = "Mr-Hamza-Javed/Notepadly"
$out = Join-Path $root "release\$Version"
New-Item -ItemType Directory -Force $out | Out-Null

# The exe must not be running, or the build can't replace it.
Get-Process notepadly -ErrorAction SilentlyContinue | Stop-Process -Force

$versioned = "package.json", "src-tauri\tauri.conf.json", "src-tauri\Cargo.toml", "src-tauri\Cargo.lock"
$saved = @{}
foreach ($f in $versioned) { $saved[$f] = [IO.File]::ReadAllBytes((Join-Path $root $f)) }

$keyFile = Join-Path $env:USERPROFILE ".tauri\notepadly-updater.key"
$passFile = Join-Path $env:USERPROFILE ".tauri\notepadly-updater.password"
$signed = (Test-Path $keyFile) -and (Test-Path $passFile)

try {
  node scripts/set-version.mjs $Version
  if ($LASTEXITCODE -ne 0) { throw "set-version failed" }

  $tauriArgs = @("tauri", "build")
  if ($signed) {
    $env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyFile -Raw).Trim()
    $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = (Get-Content $passFile -Raw).Trim()
    $tauriArgs += @("--config", "src-tauri/tauri.release.conf.json")
  } else {
    Write-Warning "No signing key in $env:USERPROFILE\.tauri: building without the auto-update feed."
  }
  npx @tauriArgs
  if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }
}
finally {
  Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  foreach ($f in $versioned) { [IO.File]::WriteAllBytes((Join-Path $root $f), $saved[$f]) }
}

$setupName = "Notepadly_${Version}_x64-setup.exe"
$nsis = Join-Path $root "src-tauri\target\release\bundle\nsis"
Copy-Item (Join-Path $nsis $setupName) $out -Force

# Portable zip: the exe plus the license files.
$stage = Join-Path $out "Notepadly"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Copy-Item "src-tauri\target\release\notepadly.exe", "LICENSE", "NOTICE", "README.md" $stage
$zip = Join-Path $out "Notepadly_${Version}_x64-portable.zip"
Remove-Item $zip -ErrorAction SilentlyContinue
Compress-Archive -Path "$stage\*" -DestinationPath $zip
Remove-Item $stage -Recurse -Force

if ($signed) {
  Copy-Item (Join-Path $nsis "$setupName.sig") $out -Force
  $platform = @{
    signature = (Get-Content (Join-Path $nsis "$setupName.sig") -Raw).Trim()
    url       = "https://github.com/$repo/releases/download/v$Version/$setupName"
  }
  $feed = [ordered]@{
    version   = $Version
    notes     = "Notepadly $Version"
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{ "windows-x86_64" = $platform; "windows-x86_64-nsis" = $platform }
  }
  [IO.File]::WriteAllText((Join-Path $out "latest.json"), ($feed | ConvertTo-Json -Depth 5))
}

Write-Host ""
Write-Host "Release $Version is ready in $out" -ForegroundColor Green
Get-ChildItem $out | ForEach-Object { "  {0,-42} {1,8:N1} MB" -f $_.Name, ($_.Length / 1MB) }
