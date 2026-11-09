#!/usr/bin/env bash
# The tools a remote worker uses as on the PC, for a server prepared by setup.sh (Ubuntu 24.04). Idempotent: run it
# again after a change (a plugin turned on, a new skill), it only does what is missing.
#
#   scp scripts/vps/tools.sh scripts/vps/envsync.mjs <admin>@<ip>:/tmp/
#   ssh <admin>@<ip> sudo bash /tmp/tools.sh
#
# Installs: gh, git, ripgrep, jq, ffmpeg, python3 with pip and venv, uv; Playwright's Chromium and Chrome with their
# system libraries, without a screen (headless); playwright-cli (the playwright-cli and taste skills); the browser of
# HyperFrames (its skills); the plugins the synced settings turn on; /opt/aibox/envsync.mjs (environment sync).
# Not installed, on purpose: Blender, Unity, a visible browser or a desktop, computer use (they drive the PC), the
# deploy tools and their accounts (Cloudflare, Supabase: deploys stay on the PC), whisper.cpp models (large; the
# skills fall back to their cloud or ask).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
id aibox >/dev/null 2>&1 || { echo "user aibox is missing: run setup.sh first" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
as_aibox() { sudo -iu aibox bash -lc "$1"; }
step() { printf '\n== %s\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

step "packages"
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg ripgrep jq ffmpeg python3 python3-pip python3-venv pipx unzip \
  fonts-noto-core fonts-noto-color-emoji fonts-liberation >/dev/null

step "GitHub CLI"
if ! command -v gh >/dev/null; then
  install -d -m 755 /etc/apt/keyrings
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg
  chmod 644 /etc/apt/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    >/etc/apt/sources.list.d/github-cli.list
  apt-get update -qq
  apt-get install -y -qq gh >/dev/null
fi
gh --version | head -1

step "environment sync (/opt/aibox/envsync.mjs)"
if [ -f "$HERE/envsync.mjs" ]; then
  install -d -m 755 -o root -g root /opt/aibox
  install -m 644 -o root -g root "$HERE/envsync.mjs" /opt/aibox/envsync.mjs
else
  echo "envsync.mjs not next to tools.sh: skipped"
fi

step "Playwright: Chromium and Chrome, headless, with their system libraries"
# The libraries need root; the browsers go in aibox's cache, where its Playwright looks.
npx -y playwright@latest install-deps chromium >/dev/null
if [ "$(dpkg --print-architecture)" = amd64 ] && ! command -v google-chrome >/dev/null; then
  npx -y playwright@latest install --with-deps chrome >/dev/null
fi
as_aibox 'npx -y playwright@latest install chromium >/dev/null'

step "playwright-cli"
npm ls -g @playwright/cli >/dev/null 2>&1 || npm install -g --silent @playwright/cli@latest
playwright-cli --version 2>/dev/null || true

step "HyperFrames browser"
as_aibox 'npx -y hyperframes@latest browser ensure >/dev/null 2>&1' || echo "hyperframes browser: not ready (the skill retries on first use)"

step "uv (Python tools of some skills)"
as_aibox 'command -v uv >/dev/null || (curl -LsSf https://astral.sh/uv/install.sh -o /tmp/uv-install.sh && sh /tmp/uv-install.sh -q && rm -f /tmp/uv-install.sh)'

step "plugins turned on in the synced settings"
SETTINGS=/home/aibox/.claude/settings.json
if [ -f "$SETTINGS" ]; then
  # Marketplaces from GitHub only (envSync.ts sends no other kind), then each plugin turned on.
  jq -r '.extraKnownMarketplaces // {} | to_entries[] | select(.value.source.source == "github") | .value.source.repo' "$SETTINGS" |
    while read -r repo; do
      [[ "$repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || continue
      as_aibox "claude plugin marketplace add '$repo' >/dev/null 2>&1" || true
    done
  jq -r '.enabledPlugins // {} | to_entries[] | select(.value == true) | .key' "$SETTINGS" |
    while read -r plugin; do
      [[ "$plugin" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]] || continue
      as_aibox "claude plugin install '$plugin' >/dev/null 2>&1" && echo "  $plugin" || echo "  $plugin: not installed"
    done
else
  echo "no synced settings yet: sync the environment from the AI Box, then run this again"
fi

step "versions"
for c in git gh rg jq python3 node npm playwright-cli; do
  printf '  %-15s %s\n' "$c" "$(command -v "$c" >/dev/null && ("$c" --version 2>&1 | head -1) || echo missing)"
done
printf '  %-15s %s\n' ffmpeg "$(ffmpeg -version 2>/dev/null | head -1 || echo missing)"
as_aibox 'printf "  %-15s %s\n" uv "$(uv --version 2>/dev/null || echo missing)"; printf "  %-15s %s\n" claude "$(claude --version 2>/dev/null || echo missing)"'
