#!/usr/bin/env bash
# AI Box for macOS and Linux: installs AI Box from its git repository (so that the app's Update button keeps working),
# with its dependencies and build, then an "AI Box" app (macOS: ~/Applications; Linux: the
# applications menu and the Desktop), and opens it. Needs git and Node.js 22.12+.
#   From a checkout: ./install.sh        Alone: bash -c "$(curl -fsSL https://raw.githubusercontent.com/Anilito1/ai_box/main/install.sh)"
set -euo pipefail
REPO_URL=https://github.com/Anilito1/ai_box.git

say() { printf '\033[36m-> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

command -v git >/dev/null || fail "git is missing: install it (macOS: xcode-select --install), then run this installer again."
command -v node >/dev/null || fail "Node.js is missing: install version 22.12 or newer from https://nodejs.org, then run this installer again."
node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' \
  || fail "Node.js $(node -v) is too old: install version 22.12 or newer from https://nodejs.org, then run this installer again."

# The checkout this script belongs to, else the one given, else ~/.local/share/ai-box.
here=""
[ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ -n "${AI_BOX_DIR:-}" ]; then dir=$AI_BOX_DIR
elif [ -n "$here" ] && [ -e "$here/.git" ]; then dir=$here
else dir="$HOME/.local/share/ai-box"
fi
if [ -e "$dir/.git" ]; then say "Using $dir"
elif [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then fail "$dir already exists and is not an AI Box checkout: move it away, then run the installer again."
else say "Downloading AI Box into $dir"; git clone "$REPO_URL" "$dir"
fi
cd "$dir"
dir=$(pwd)

if [ "$(uname)" = Darwin ]; then electron="$dir/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
else electron="$dir/node_modules/electron/dist/electron"
fi
if [ ! -x "$electron" ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  # The same commands as the app's own updates: npm ci leaves package-lock.json as it is (a local change would block
  # the Update button), and Electron's binary is fetched by its installer.
  say "Installing the dependencies (a few minutes)"
  npm ci --ignore-scripts --no-audit --no-fund
  node node_modules/electron/install.js
fi
say "Building"
npm run build

say "Creating the AI Box app"
if [ "$(uname)" = Darwin ]; then
  app="$HOME/Applications/AI Box.app"
  mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
  icons=$(mktemp -d)/icon.iconset
  mkdir -p "$icons"
  for s in 16 32 128 256 512; do
    sips -z $s $s assets/icon.png --out "$icons/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) assets/icon.png --out "$icons/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$icons" -o "$app/Contents/Resources/icon.icns"
  rm -rf "$(dirname "$icons")"
  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>AI Box</string>
  <key>CFBundleIdentifier</key><string>io.github.anilito1.hub.launcher</string>
  <key>CFBundleExecutable</key><string>AI Box</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
EOF
  printf '#!/bin/sh\nexec "%s" "%s"\n' "$electron" "$dir" > "$app/Contents/MacOS/AI Box"
  chmod +x "$app/Contents/MacOS/AI Box"
  done_msg="AI Box is installed: open it from Applications (~/Applications)."
  open_cmd=(open "$app")
else
  desktop_file="$HOME/.local/share/applications/ai-box.desktop"
  mkdir -p "$(dirname "$desktop_file")"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=AI Box
Exec="$electron" "$dir"
Icon=$dir/assets/icon.png
Terminal=false
Categories=Development;
StartupWMClass=claude-hub
EOF
  chmod +x "$desktop_file"
  desk=$(xdg-user-dir DESKTOP 2>/dev/null || echo "$HOME/Desktop")
  [ -d "$desk" ] && [ "$desk" != "$HOME" ] && cp "$desktop_file" "$desk/AI Box.desktop" && chmod +x "$desk/AI Box.desktop"
  done_msg="AI Box is installed: open it from your applications menu or the AI Box icon on your Desktop."
  open_cmd=("$electron" "$dir")
fi

printf '\n\033[32m%s\033[0m\n' "$done_msg"
[ -n "${AI_BOX_NO_LAUNCH:-}" ] || (cd "$dir" && nohup "${open_cmd[@]}" >/dev/null 2>&1 &)
