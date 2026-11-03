# Installs AI Box on Windows from its git repository, so that the app's Update button keeps working: git and Node.js
# (through winget when missing, else from their publishers), a checkout, its dependencies and build, then the Desktop
# and Start menu shortcuts.
# Run by install.cmd (double-click); a second run reuses the checkout and only repairs what is missing.
param(
  [string]$Dir = '',
  [string]$Desktop = '',
  [string]$StartMenu = '',
  [switch]$NoLaunch,
  # A commit to install instead of main (tests).
  [string]$Ref = $env:AIBOX_REF
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repoUrl = 'https://github.com/Anilito1/ai_box.git'
$arm = $env:PROCESSOR_ARCHITECTURE -eq 'ARM64'

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
  if (-not (Has winget)) { return }
  Say "Installing $name (Windows may ask for your permission)"
  winget install --id $id -e --silent --accept-package-agreements --accept-source-agreements | Out-Host
  Refresh-Path
}
function Download($url, $file) { Invoke-WebRequest $url -OutFile $file -UseBasicParsing -Headers @{ 'User-Agent' = 'ai-box-installer' } }

# Without winget (older Windows 10, or winget failed): Git for Windows for this user only, its signed installer from
# its GitHub releases.
function Install-Git-Direct {
  Say 'Installing git'
  $release = Invoke-RestMethod 'https://api.github.com/repos/git-for-windows/git/releases/latest' -Headers @{ 'User-Agent' = 'ai-box-installer' }
  $pattern = if ($arm) { '^Git-[\d.]+-arm64\.exe$' } else { '^Git-[\d.]+-64-bit\.exe$' }
  $asset = $release.assets | Where-Object { $_.name -match $pattern } | Select-Object -First 1
  if (-not $asset) { Fail 'git could not be downloaded. Install it (https://git-scm.com), then run this installer again.' }
  $exe = Join-Path $env:TEMP $asset.name
  Download $asset.browser_download_url $exe
  if ((Get-AuthenticodeSignature $exe).Status -ne 'Valid') { Remove-Item $exe -Force; Fail 'The git download is not signed: run this installer again.' }
  Start-Process $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/CURRENTUSER' -Wait
  Remove-Item $exe -Force -ErrorAction SilentlyContinue
  Refresh-Path
}

# Node.js 24 (LTS) from nodejs.org, checked against its published checksum, in a folder of its own on the user's PATH:
# no administrator rights.
function Install-Node-Direct {
  Say 'Installing Node.js'
  $base = 'https://nodejs.org/dist/latest-v24.x'
  $arch = if ($arm) { 'arm64' } else { 'x64' }
  $sums = [string](Invoke-RestMethod "$base/SHASUMS256.txt")
  $line = $sums -split "`n" | Where-Object { $_ -match "^[0-9a-f]{64}  node-v[\d.]+-win-$arch\.zip$" } | Select-Object -First 1
  if (-not $line) { Fail 'Node.js could not be downloaded. Install it (https://nodejs.org), then run this installer again.' }
  $sum, $file = $line -split '  '
  $name = $file -replace '\.zip$', ''
  $zip = Join-Path $env:TEMP $file
  Download "$base/$file" $zip
  if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $sum) { Remove-Item $zip -Force; Fail 'The Node.js download is damaged: run this installer again.' }
  $nodeDir = Join-Path $env:LOCALAPPDATA 'Programs\AI Box Node'
  $unpacked = Join-Path $env:TEMP $name
  Remove-Item $unpacked, $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force (Split-Path $nodeDir) | Out-Null
  Expand-Archive $zip $env:TEMP -Force
  Move-Item $unpacked $nodeDir
  Remove-Item $zip -Force
  # On the user's PATH as it is written (%VARIABLES% kept), then announced, so that the shortcuts started from the
  # Desktop see it: the app's updates run npm with it.
  $userPath = [string](Get-Item 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')
  if (($userPath -split ';') -notcontains $nodeDir) {
    Set-ItemProperty 'HKCU:\Environment' Path ((@($nodeDir) + @($userPath -split ';' | Where-Object { $_ })) -join ';') -Type ExpandString
    Add-Type -Namespace AiBox -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);'
    $r = [UIntPtr]::Zero
    [AiBox.Env]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r) | Out-Null
  }
  $env:Path = "$nodeDir;$env:Path"
}

function Run($exe, [string[]]$arguments) {
  & $exe @arguments | Out-Host
  if ($LASTEXITCODE -ne 0) { Fail "Failed: $exe $($arguments -join ' ')" }
}

if (-not (Has git)) { Winget-Install 'Git.Git' 'git' }
if (-not (Has git)) { Install-Git-Direct }
if (-not (Has git)) { Fail 'git was installed but is not found yet: close this window and run the installer again.' }
if (-not (Node-Ok)) { Winget-Install 'OpenJS.NodeJS.LTS' 'Node.js' }
# An older Node.js would stay first on the PATH, before the one of the fallback: the user updates it.
if ((Has node) -and -not (Node-Ok)) { Fail "Node.js $(node -v) is too old: update it to 22.12 or newer (https://nodejs.org), then run this installer again." }
if (-not (Node-Ok)) { Install-Node-Direct }
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
  Run git @('clone', '-q', $repoUrl, $Dir)
}
if ($Ref) { Run git @('-C', $Dir, 'checkout', '-q', '--detach', $Ref) }

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
