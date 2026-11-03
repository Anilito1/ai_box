#!/bin/sh
# macOS: "AI Box.app", a copy of the checkout's Electron.app under AI Box's name, icon and bundle id, so that the
# Dock, Launchpad, the menu bar and the permission prompts say AI Box rather than Electron. A launcher that only
# started node_modules' Electron.app would show up as Electron.
#   make <app>    creates or refreshes it (install.sh)
#   launch <app>  its executable: refreshes the copy when an update brought another Electron, then starts the checkout
# The app's updates restart the copy itself (process.execPath), and leave its bundle alone: npm ci only replaces
# node_modules, where the copy is made from.
set -eu
dir=$(cd "$(dirname "$0")/.." && pwd)
src="$dir/node_modules/electron/dist/Electron.app"
node_bin="$HOME/.local/share/ai-box-node/bin"
# Refresh the wrapper when Electron, its layout or the macOS icon changes.
stamp() { printf '%s/2/%s\n' "$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$dir/node_modules/electron/package.json")" "$(shasum -a 256 "$dir/assets/icon-macos.png" | cut -d ' ' -f 1)"; }

make_app() {
  app=$1
  # Another app at that place (the packaged build) is left alone.
  if [ -e "$app" ] && [ ! -f "$app/Contents/Resources/ai-box-stamp" ]; then
    echo "$app is another build of AI Box: move it to the Trash, then run this installer again." >&2
    exit 1
  fi
  # An update's npm ci leaves Electron's package without its binary: its installer fetches it again.
  [ -d "$src" ] || (cd "$dir" && node node_modules/electron/install.js)
  new="$app.new"
  rm -rf "$new"
  mkdir -p "$(dirname "$app")"
  ditto "$src" "$new"
  plist="$new/Contents/Info.plist"
  set_key() { plutil -replace "$1" -string "$2" "$plist"; }
  set_key CFBundleName 'AI Box'
  set_key CFBundleDisplayName 'AI Box'
  set_key CFBundleIdentifier io.github.anilito1.hub
  set_key CFBundleExecutable 'AI Box'
  set_key CFBundleIconFile ai-box.icns
  # The microphone and speech prompts of dictation, as the packaged build has them (without them macOS stops the app).
  keys=$(node -e 'for (const [k, v] of Object.entries(require(process.argv[1]).build.mac.extendInfo)) console.log(`${k}\t${v}`)' "$dir/package.json")
  [ -n "$keys" ]
  printf '%s\n' "$keys" | while IFS="$(printf '\t')" read -r key value; do set_key "$key" "$value"; done

  icons=$(mktemp -d)/ai-box.iconset
  mkdir -p "$icons"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$dir/assets/icon-macos.png" --out "$icons/icon_${s}x${s}.png" >/dev/null
    sips -z $((s * 2)) $((s * 2)) "$dir/assets/icon-macos.png" --out "$icons/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$icons" -o "$new/Contents/Resources/ai-box.icns"
  rm -rf "$(dirname "$icons")"

  # The checkout's path, in a script of the bundle: the start itself is this file's, so updates can change it.
  q=$(printf '%s' "$dir" | sed "s/'/'\\\\''/g")
  printf '#!/bin/sh\nexec /bin/sh '\''%s/scripts/macos-app.sh'\'' launch "$(cd "$(dirname "$0")/../.." && pwd)"\n' "$q" > "$new/Contents/MacOS/AI Box"
  chmod +x "$new/Contents/MacOS/AI Box"
  stamp > "$new/Contents/Resources/ai-box-stamp"

  # The new Info.plist breaks Electron's signature: signed again for this Mac (Apple Silicon runs only signed code).
  codesign --force --sign - "$new/Contents/MacOS/Electron"
  codesign --force --deep --sign - "$new"
  rm -rf "$app.old"
  [ ! -e "$app" ] || mv "$app" "$app.old"
  mv "$new" "$app"
  rm -rf "$app.old"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" 2>/dev/null || true
  echo "ok  $app"
}

launch() {
  app=$1
  # The Node.js install.sh brought, when the Mac had none recent enough: the app's updates run npm with it.
  if [ -x "$node_bin/node" ]; then
    PATH="$node_bin:$PATH" AI_BOX_NODE=$node_bin
    export PATH AI_BOX_NODE
  fi
  if [ "$(cat "$app/Contents/Resources/ai-box-stamp" 2>/dev/null)" != "$(stamp)" ]; then
    # Node.js for Electron's installer: also where the user's shell finds it (nvm, Homebrew...).
    PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$("${SHELL:-/bin/zsh}" -ilc 'printf %s "$PATH"' 2>/dev/null </dev/null || true)"
    osascript -e 'display notification "Getting AI Box ready after its update (about a minute)." with title "AI Box"' >/dev/null 2>&1 || true
    # In its own shell, so that a failing step stops it; failed (offline), the copy as it is starts.
    sh "$dir/scripts/macos-app.sh" make "$app" >/dev/null 2>&1 || true
  fi
  cd "$dir"
  exec "$app/Contents/MacOS/Electron" "$dir"
}

case "${1:-}" in
  make) make_app "$2" ;;
  launch) launch "$2" ;;
  *) echo "usage: macos-app.sh make|launch <path of AI Box.app>" >&2; exit 2 ;;
esac
