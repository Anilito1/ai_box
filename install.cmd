@echo off
rem AI Box for Windows: double-click. Installs git and Node.js when missing, then AI Box with its Desktop and Start
rem menu icons, and opens it. From a checkout it installs that checkout; alone (downloaded file) it fetches the rest.
rem AIBOX_REF: a commit to install instead of main (tests).
setlocal
rem Started from PowerShell 7, Windows PowerShell would load PowerShell 7's modules and fail (Get-FileHash): its own.
set "PSModulePath="
set "SCRIPT=%~dp0scripts\install-windows.ps1"
set "LOCAL="
if exist "%~dp0.git" if exist "%SCRIPT%" set "LOCAL=1"
if defined LOCAL (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  set "AIBOX_ARGS=%*"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ref = if ($env:AIBOX_REF) { $env:AIBOX_REF } else { 'main' }; $s = [scriptblock]::Create((Invoke-RestMethod ('https://raw.githubusercontent.com/Anilito1/ai_box/' + $ref + '/scripts/install-windows.ps1'))); Invoke-Expression ('& $s ' + $env:AIBOX_ARGS)"
)
if errorlevel 1 (
  echo.
  echo Installation failed: read the message above.
  pause
  exit /b 1
)
