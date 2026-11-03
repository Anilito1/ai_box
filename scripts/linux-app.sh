#!/bin/sh
# Linux: AI Box's entry in the applications menu (and on the Desktop), and its start.
#   install  writes the entry, and where Ubuntu (23.10+) keeps apps from Chromium's sandbox, allows Electron's
#            (AppArmor profile, the password is asked once)
#   launch   the entry's command
set -eu
dir=$(cd "$(dirname "$0")/.." && pwd)
electron="$dir/node_modules/electron/dist/electron"
profile=/etc/apparmor.d/ai-box
data="${XDG_DATA_HOME:-$HOME/.local/share}"

as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
# Ubuntu 23.10+ lets only the programs an AppArmor profile allows create the namespaces Chromium's sandbox runs in.
restricted() { [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; }
# The other way out: a chrome-sandbox set up by root (setuid). npm replaces it at the updates that reinstall Electron.
setuid_sandbox() { [ -u "$dir/node_modules/electron/dist/chrome-sandbox" ] && [ "$(stat -c %u "$dir/node_modules/electron/dist/chrome-sandbox")" = 0 ]; }

# A profile on Electron's path, as Ubuntu ships for Chrome: it outlives the updates, which put Electron at the same path.
allow_sandbox() {
  if [ ! -x /usr/sbin/apparmor_parser ] && [ ! -x /sbin/apparmor_parser ]; then
    echo "AppArmor is not installed here: AI Box will start without Chromium's sandbox."
    return
  fi
  echo "-> Ubuntu allows the security sandbox of apps one by one: allowing AI Box's (your password may be asked)"
  tmp=$(mktemp)
  cat > "$tmp" <<EOF
abi <abi/4.0>,
include <tunables/global>

profile ai-box "$electron" flags=(unconfined) {
  userns,

  include if exists <local/ai-box>
}
EOF
  if as_root install -m 644 "$tmp" "$profile" && as_root apparmor_parser -r "$profile"; then
    echo "ok  $profile"
  else
    as_root rm -f "$profile" 2>/dev/null || true
    echo "AI Box could not be allowed: it will start without Chromium's sandbox (run this installer again to allow it)."
  fi
  rm -f "$tmp"
}

install_entry() {
  apps="$data/applications"
  mkdir -p "$apps"
  # Named after the app's window class (package.json "name"), so that the dock groups the window under this entry.
  entry="$apps/claude-hub.desktop"
  rm -f "$apps/ai-box.desktop"
  cat > "$entry" <<EOF
[Desktop Entry]
Type=Application
Name=AI Box
Comment=Run your Claude Code, Codex and Gemini sessions side by side
Exec=/bin/sh "$dir/scripts/linux-app.sh" launch
Icon=$dir/assets/icon.png
Terminal=false
Categories=Development;
StartupWMClass=claude-hub
StartupNotify=true
EOF
  chmod +x "$entry"
  command -v update-desktop-database >/dev/null && update-desktop-database "$apps" 2>/dev/null || true
  echo "ok  $entry"
  desk=$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")
  if [ -d "$desk" ] && [ "$desk" != "$HOME" ]; then
    cp "$entry" "$desk/AI Box.desktop"
    chmod +x "$desk/AI Box.desktop"
    # GNOME opens a launcher on the Desktop only once trusted.
    gio set "$desk/AI Box.desktop" metadata::trusted true 2>/dev/null || true
  fi
  if restricted && [ ! -e "$profile" ] && ! setuid_sandbox; then allow_sandbox; fi
}

launch() {
  node_bin="$data/ai-box-node/bin"
  # The Node.js install.sh brought, when the computer had none recent enough: the app's updates run npm with it.
  if [ -x "$node_bin/node" ]; then
    PATH="$node_bin:$PATH" AI_BOX_NODE=$node_bin
    export PATH AI_BOX_NODE
  fi
  # Last resort, when the password was not given: Electron would stop at its start, it runs without the sandbox.
  if restricted && [ ! -e "$profile" ] && ! setuid_sandbox; then set -- --no-sandbox; else set --; fi
  cd "$dir"
  exec "$electron" "$@" "$dir"
}

case "${1:-}" in
  install) install_entry ;;
  launch) launch ;;
  *) echo "usage: linux-app.sh install|launch" >&2; exit 2 ;;
esac
