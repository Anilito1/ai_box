# Installs AI Box on Windows from its git repository, so that the app's Update button keeps working: git and Node.js
# (through winget when missing), a checkout, its dependencies and build, then the Desktop and Start menu shortcuts.
# Run by install.cmd (double-click); a second run reuses the checkout and only repairs what is missing.
param(
  [string]$Dir = '',
  [string]$Desktop = '',
  [string]$StartMenu = '',
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$repoUrl = 'https://github.com/Anilito1/ai_box.git'

function Say($text) { Write-Host "-> $text" -ForegroundColor Cyan }
function Fail($text) { Write-Host "`n$text" -ForegroundColor Red; exit 1 }
function Refresh-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
function Has($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Node-Ok {
  if (-not (Has node)) { return $false }
  $v = [version]((node -v) -replace '^v', '')
  return $v -ge [version]'22.12.0'
}
function Winget-Install($id, $name) {
  if (-not (Has winget)) { Fail "$name is missing. Install it, then run this installer again: $(if ($id -eq 'Git.Git') { 'https://git-scm.com' } else { 'https://nodejs.org' })" }
  Say "Installing $name (Windows may ask for your permission)"
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
}
function Run($exe, [string[]]$arguments) {
  & $exe @arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "Failed: $exe $($arguments -join ' ')" }
}

if (-not (Has git)) { Winget-Install 'Git.Git' 'git' }
if (-not (Has git)) { Fail 'git was installed but is not found yet: close this window and run the installer again.' }
if (Has node) {
  if (-not (Node-Ok)) { Fail "Node.js $(node -v) is too old: update it to 22.12 or newer (https://nodejs.org), then run this installer again." }
} else { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js' }
if (-not (Node-Ok)) { Fail 'Node.js 22.12 or newer is needed and was not found: close this window and run the installer again.' }

# The checkout this script belongs to, else the one given, else the usual folder for the user's own apps.
if (-not $Dir) {
  $here = if ($PSScriptRoot) { Split-Path $PSScriptRoot -Parent } else { '' }
  $Dir = if ($here -and (Test-Path (Join-Path $here '.git'))) { $here } else { Join-Path $env:LOCALAPPDATA 'Programs\AI Box' }
}
if (Test-Path (Join-Path $Dir '.git')) {
  Say "Using $Dir"
} elseif ((Test-Path $Dir) -and (Get-ChildItem $Dir -Force | Select-Object -First 1)) {
  Fail "$Dir already exists and is not an AI Box checkout: move it away, then run the installer again."
} else {
  Say "Downloading AI Box into $Dir"
  Run git @('clone', $repoUrl, $Dir)
}

Push-Location $Dir
try {
  $electron = Join-Path $Dir 'node_modules\electron\dist\electron.exe'
  $lock = Join-Path $Dir 'node_modules\.package-lock.json'
  $stale = -not (Test-Path $lock) -or (Get-Item (Join-Path $Dir 'package-lock.json')).LastWriteTime -gt (Get-Item $lock).LastWriteTime
  if ($stale -or -not (Test-Path $electron)) {
    # The same commands as the app's own updates: npm ci leaves package-lock.json as it is (a local change would block
    # the Update button), and Electron's binary is fetched by its installer.
    Say 'Installing the dependencies (a few minutes)'
    Run npm.cmd @('ci', '--ignore-scripts', '--no-audit', '--no-fund')
    Run node @('node_modules/electron/install.js')
  }
  Say 'Building'
  Run npm.cmd @('run', 'build')
  Say 'Creating the shortcuts'
  $shortcutArgs = @{}
  if ($Desktop) { $shortcutArgs.Desktop = $Desktop }
  if ($StartMenu) { $shortcutArgs.StartMenu = $StartMenu }
  & (Join-Path $Dir 'scripts\windows-shortcuts.ps1') @shortcutArgs | Out-Host
} finally {
  Pop-Location
}

Write-Host "`nAI Box is installed: open it from the AI Box icon on your Desktop or in the Start menu." -ForegroundColor Green
if (-not $NoLaunch) { Start-Process $electron -ArgumentList "`"$Dir`"" -WorkingDirectory $Dir }
