#!/usr/bin/env bash
# The tools a remote worker uses as on the PC (Ubuntu 24.04), run by setup.sh before it puts the launcher in place.
# Idempotent: it only does what is missing. Every tool is optional: one that fails is reported and the rest goes on,
# so a broken download never blocks the server's setup.
#
# Installs: gh, ripgrep, jq, ffmpeg, python3 with pip and venv, uv; Playwright's Chromium (and Chrome on x86) with
# their system libraries, without a screen; playwright-cli (the playwright-cli and taste skills); HyperFrames' browser;
# the document skills' tools (poppler, qpdf, pandoc, ImageMagick, Tesseract, their Python modules, LibreOffice headless).
# The plugins are installed by envsync.mjs, from its own list, when the environment is synced.
# Not installed, on purpose: Blender, Unity, a visible browser or a desktop, computer use (they drive the PC), deploy
# tools and their accounts (deploys stay on the PC), whisper.cpp and its models (large; the skills say what is missing).
set -uo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
id aibox >/dev/null 2>&1 || { echo "user aibox is missing: run setup.sh first" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive
failed=()
# The boot of a fresh or unshelved server runs its security updates: every apt here, Playwright's too, waits for
# their lock instead of failing.
lock_conf=/etc/apt/apt.conf.d/90aibox-tools-lock
echo 'DPkg::Lock::Timeout "600";' >"$lock_conf"
trap 'rm -f "$lock_conf"' EXIT
# Not `sudo -i`: it hands the command to a login shell that expands its $variables first, empty.
as_aibox() { sudo -u aibox -H bash -lc "cd ~ && $1"; }
tool() {
  local name="$1"
  shift
  printf '\n== %s\n' "$name"
  if ! "$@"; then
    echo "   $name: failed, skipped"
    failed+=("$name")
  fi
}

packages() {
  apt-get update -qq &&
    apt-get install -y -qq git curl ca-certificates gnupg ripgrep jq ffmpeg python3 python3-pip python3-venv unzip \
      fonts-noto-core fonts-noto-color-emoji fonts-liberation >/dev/null
}

github_cli() {
  command -v gh >/dev/null && return 0
  install -d -m 755 /etc/apt/keyrings &&
    curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg &&
    chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg &&
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      >/etc/apt/sources.list.d/github-cli.list &&
    apt-get update -qq && apt-get install -y -qq gh >/dev/null
}

# The libraries need root; the browsers go in aibox's cache, where its Playwright looks.
browsers() {
  npx -y playwright@latest install-deps chromium >/dev/null || return 1
  if [ "$(dpkg --print-architecture)" = amd64 ] && ! command -v google-chrome >/dev/null; then
    npx -y playwright@latest install --with-deps chrome >/dev/null || return 1
  fi
  as_aibox 'npx -y playwright@latest install chromium >/dev/null'
}

playwright_cli() {
  npm ls -g @playwright/cli >/dev/null 2>&1 || npm install -g --silent @playwright/cli@latest
}

hyperframes_browser() {
  as_aibox 'npx -y hyperframes@latest browser ensure >/dev/null 2>&1'
}

uv_tool() {
  as_aibox 'command -v uv >/dev/null || (curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh && sh /tmp/uv-install.sh -q; s=$?; rm -f /tmp/uv-install.sh; exit $s)'
}

# The document skills (pdf, docx, xlsx, pptx): their command-line tools, and their Python modules from Ubuntu's own
# packages (pip may not write the system Python, and aibox has no sudo); one Ubuntu does not package goes in aibox's
# own folder (pip --user).
documents() {
  apt-get update -qq && apt-get install -y -qq poppler-utils qpdf pandoc imagemagick tesseract-ocr >/dev/null || return 1
  local debs=() pips=() m
  for m in defusedxml lxml pypdf pdfplumber:pdfplumber pil:pillow openpyxl pandas docx:python-docx pptx:python-pptx reportlab markdown; do
    if apt-cache show "python3-${m%%:*}" >/dev/null 2>&1; then debs+=("python3-${m%%:*}"); else pips+=("${m#*:}"); fi
  done
  apt-get install -y -qq "${debs[@]}" >/dev/null || return 1
  [ ${#pips[@]} -eq 0 ] || as_aibox "python3 -m pip install -q --user --break-system-packages ${pips[*]}"
}

# Office files to PDF and back (docx, xlsx, pptx skills): LibreOffice without its interface, about 400 MB.
office() {
  command -v soffice >/dev/null && return 0
  apt-get install -y -qq --no-install-recommends libreoffice-writer-nogui libreoffice-calc-nogui libreoffice-impress-nogui >/dev/null
}

tool "packages" packages
tool "document tools" documents
tool "LibreOffice (headless)" office
tool "GitHub CLI" github_cli
tool "Playwright browsers (headless)" browsers
tool "playwright-cli" playwright_cli
tool "HyperFrames browser" hyperframes_browser
tool "uv" uv_tool

printf '\n== versions\n'
for c in git gh rg jq python3 node npm playwright-cli pandoc qpdf soffice; do
  printf '  %-15s %s\n' "$c" "$(command -v "$c" >/dev/null && ("$c" --version 2>&1 | head -1) || echo missing)"
done
printf '  %-15s %s\n' ffmpeg "$(ffmpeg -version 2>/dev/null | head -1 || echo missing)"
as_aibox 'printf "  %-15s %s\n" uv "$(uv --version 2>/dev/null || echo missing)"'
[ ${#failed[@]} -eq 0 ] || echo "tools not installed: ${failed[*]} (run setup again to retry)"
exit 0
