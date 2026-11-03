#!/usr/bin/env bash
# CI (workflows/install.yml), macOS and Linux: checks what install.sh installed. The app is in Applications or the
# applications menu under AI Box's name, starts and keeps running, and the Update button still works: the checkout is
# clean and official, and the app starts again after an update's `npm ci` (and on macOS, after a new Electron).
# OUT: the folder for the logs and captures.
set -euo pipefail
dir="$HOME/.local/share/ai-box"
node_home="${XDG_DATA_HOME:-$HOME/.local/share}/ai-box-node"
out=${OUT:-$PWD}
log="$out/app.log"
mkdir -p "$out"
: > "$log"
[ -x "$node_home/bin/node" ] && PATH="$node_home/bin:$PATH"

step() { printf '\n== %s\n' "$1"; }
fail() {
  printf '\nFAILED: %s\n' "$1" >&2
  tail -n 60 "$log" >&2 || true
  exit 1
}

step "The checkout is clean and official (the Update button refuses anything else)"
git -C "$dir" status --porcelain
[ -z "$(git -C "$dir" status --porcelain)" ] || fail "the checkout has local changes"
[ "$(git -C "$dir" remote get-url origin)" = https://github.com/Anilito1/ai_box.git ] || fail "origin is not the official repository"

if [ "$(uname)" = Darwin ]; then
  app="/Applications/AI Box.app"
  exe="$app/Contents/MacOS/Electron"
  step "AI Box.app"
  ls -la "$app/Contents/MacOS"
  [ "$(plutil -extract CFBundleName raw "$app/Contents/Info.plist")" = "AI Box" ] || fail "CFBundleName"
  [ -f "$app/Contents/Resources/ai-box.icns" ] || fail "icon"
  codesign --verify --deep --strict "$app" && echo "signature: valid" || echo "signature: not valid"
  start() { open "$app"; }
  env_of() { ps eww -p "$1" -o command=; }
  named() {
    lsappinfo list | grep -E '"AI Box"|anilito1' || true
    lsappinfo list | grep -q '"AI Box" ASN'
  }
  shot() { screencapture -x "$out/$1.png" || true; }
else
  entry="${XDG_DATA_HOME:-$HOME/.local/share}/applications/claude-hub.desktop"
  exe="$dir/node_modules/electron/dist/electron"
  step "Menu entry"
  cat "$entry"
  grep -qx 'Name=AI Box' "$entry" || fail "Name"
  grep -qx 'StartupWMClass=claude-hub' "$entry" || fail "StartupWMClass"
  icon=$(sed -n 's/^Icon=//p' "$entry")
  [ -f "$icon" ] || fail "icon $icon"
  # A container (Fedora) sees the host's setting without AppArmor: AI Box starts there without the sandbox.
  if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] && [ -d /etc/apparmor.d ]; then
    step "AppArmor restricts the sandbox here: AI Box's profile"
    cat /etc/apparmor.d/ai-box || fail "no AppArmor profile"
  fi
  if [ -z "${DISPLAY:-}" ]; then
    Xvfb :99 -screen 0 1280x800x24 >/dev/null 2>&1 &
    export DISPLAY=:99
    sleep 2
  fi
  eval "set -- $(sed -n 's/^Exec=//p' "$entry")"
  launcher=("$@")
  start() { (cd "$HOME" && nohup "${launcher[@]}" >>"$log" 2>&1 &); }
  env_of() { tr '\0' '\n' < "/proc/$1/environ"; }
  named() {
    local wid
    wid=$(xdotool search --class claude-hub | tail -n 1)
    [ -n "$wid" ] || return 1
    xprop -id "$wid" WM_CLASS _NET_WM_NAME
    xprop -id "$wid" WM_CLASS | grep -q '"claude-hub"'
  }
  shot() { import -window root "$out/$1.png" 2>/dev/null || true; }
fi

# The main process: on Linux the helpers are the same executable, with a --type.
main_pid() {
  local p
  for p in $(pgrep -f "^$exe" || true); do
    ps -o command= -p "$p" | grep -q -- --type= || { echo "$p"; return; }
  done
}

stop() {
  pkill -f "^$exe" || true
  for _ in $(seq 30); do pgrep -f "^$exe" >/dev/null || return 0; sleep 1; done
  pkill -9 -f "^$exe" || true
}

# Started, still running 30 s later with its renderer, under AI Box's name, with the Node.js the updates need.
check_running() {
  local pid
  sleep 30
  pid=$(main_pid)
  [ -n "$pid" ] || fail "$1: AI Box is not running"
  ps -o pid=,command= -p "$pid"
  pgrep -f -- "--type=renderer" >/dev/null || fail "$1: no renderer process"
  named || fail "$1: the app is not shown under AI Box's name"
  if [ "$(uname)" != Darwin ] && [ -e /etc/apparmor.d/ai-box ]; then
    ps -o command= -p "$pid" | grep -q -- --no-sandbox && fail "$1: started without the sandbox"
  fi
  if [ -x "$node_home/bin/node" ]; then
    env_of "$pid" | grep -q "AI_BOX_NODE=$node_home/bin" || fail "$1: the app does not get the installed Node.js"
  fi
  shot "$2"
  echo "ok  $1"
}

step "First start, as from the Dock or the menu"
start
check_running "first start" start

step "After an update that reinstalls the dependencies, the restart the update makes"
args=$(ps -o command= -p "$(main_pid)")
stop
(
  cd "$dir"
  npm ci --ignore-scripts --no-audit --no-fund --prefer-offline </dev/null
  # As the update's helper: Electron's binary is fetched again only when the app's executable is gone.
  [ -e "$exe" ] || node node_modules/electron/install.js </dev/null
  npm run build </dev/null
)
case "$args" in *--no-sandbox*) relaunch=("$exe" --no-sandbox "$dir") ;; *) relaunch=("$exe" "$dir") ;; esac
# With the environment the app had, as the update's helper does.
[ -x "$node_home/bin/node" ] && export AI_BOX_NODE="$node_home/bin"
(cd "$dir" && nohup "${relaunch[@]}" >>"$log" 2>&1 &)
check_running "restart after an update" update
stop

if [ "$(uname)" = Darwin ]; then
  step "After an update that brings another Electron: the next start makes the app again"
  echo 0 > "$app/Contents/Resources/ai-box-stamp"
  start
  sleep 60
  [ "$(cat "$app/Contents/Resources/ai-box-stamp")" != 0 ] || fail "the app was not made again"
  check_running "start after a new Electron" electron
  stop
fi

step "Opened again from the Dock or the menu"
start
check_running "second start" again
stop
echo
echo "All checks passed."
