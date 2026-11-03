#!/usr/bin/env bash
# AI Box for macOS and Linux, one command in a terminal:
#   curl -fsSL https://github.com/Anilito1/ai_box/releases/latest/download/install.sh | bash
# Installs what is missing (git; Node.js in a folder of its own when the computer has none recent enough), AI Box
# from its git repository (so that the app's Update button keeps working) with its dependencies and build, then the
# app: macOS "AI Box" in Applications and Launchpad, Linux an entry in the applications menu. Then opens it.
# From a checkout (./install.sh) it installs that checkout. AI_BOX_DIR: another folder; AI_BOX_REF: a commit to
# install instead of main (tests); AI_BOX_NO_LAUNCH=1: does not open it at the end.
set -euo pipefail

REPO_URL=https://github.com/Anilito1/ai_box.git
# Where the Node.js this installer brings lives: scripts/macos-app.sh and scripts/linux-app.sh look there too.
NODE_HOME="${XDG_DATA_HOME:-$HOME/.local/share}/ai-box-node"

say() { printf '\033[36m-> %s\033[0m\n' "$1"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$1" >&2; exit 1; }
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi; }
fetch() {
  if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null; then wget -qO "$2" "$1"
  else fail "curl or wget is needed to download AI Box: install one, then run this installer again."
  fi
}
node_ok() {
  command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)' 2>/dev/null
}

# git: on macOS it comes with Apple's command line tools, which open their own install window.
need_git() {
  if [ "$(uname)" = Darwin ]; then
    xcode-select -p >/dev/null 2>&1 && return
    [ -n "$(command -v git)" ] && [ "$(command -v git)" != /usr/bin/git ] && return
    say "macOS needs its command line tools (they bring git): click Install in the window that opens, then wait here"
    xcode-select --install >/dev/null 2>&1 || true
    local waited=0
    until xcode-select -p >/dev/null 2>&1; do
      [ "$waited" -ge 3600 ] && fail "The command line tools are still not installed: install them (xcode-select --install), then run this installer again."
      sleep 5; waited=$((waited + 5))
    done
    return
  fi
  command -v git >/dev/null && return
  say "Installing git (your password may be asked)"
  if command -v apt-get >/dev/null; then as_root apt-get update -qq && as_root apt-get install -y -qq git
  elif command -v dnf >/dev/null; then as_root dnf install -y -q git
  elif command -v zypper >/dev/null; then as_root zypper --non-interactive install git
  elif command -v pacman >/dev/null; then as_root pacman -S --noconfirm --needed git
  else fail "git is missing: install it, then run this installer again."
  fi
  command -v git >/dev/null || fail "git could not be installed: install it, then run this installer again."
}

# Node.js 24 (LTS) from nodejs.org, checked against its published checksum, in $NODE_HOME: no administrator rights,
# nothing else on the computer changes. AI Box's launcher puts it on the app's PATH.
need_node() {
  node_ok && return
  local os arch base tmp name sum
  case "$(uname)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail "This system is not supported." ;; esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "This processor ($(uname -m)) is not supported: install Node.js 22.12 or newer, then run this installer again." ;;
  esac
  # An Apple Silicon Mac whose terminal runs under Rosetta still gets the arm64 build.
  [ "$os" = darwin ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && arch=arm64
  say "Downloading Node.js"
  base=https://nodejs.org/dist/latest-v24.x
  tmp=$(mktemp -d)
  fetch "$base/SHASUMS256.txt" "$tmp/sums"
  name=$(grep -o "node-v[0-9.]*-$os-$arch\.tar\.gz" "$tmp/sums" | head -n 1)
  [ -n "$name" ] || fail "Node.js for this computer was not found on nodejs.org: install it, then run this installer again."
  fetch "$base/$name" "$tmp/$name"
  sum=$( (sha256sum "$tmp/$name" 2>/dev/null || shasum -a 256 "$tmp/$name") | cut -d ' ' -f 1)
  grep -q "^$sum  $name\$" "$tmp/sums" || fail "The Node.js download is damaged: run this installer again."
  rm -rf "$NODE_HOME" && mkdir -p "$NODE_HOME"
  tar -xzf "$tmp/$name" -C "$NODE_HOME" --strip-components 1
  rm -rf "$tmp"
  PATH="$NODE_HOME/bin:$PATH"
  node_ok || fail "Node.js could not be installed: install version 22.12 or newer from https://nodejs.org, then run this installer again."
}

main() {
  [ -x "$NODE_HOME/bin/node" ] && PATH="$NODE_HOME/bin:$PATH"
  need_git
  need_node

  # The checkout this script belongs to, else the one given, else ~/.local/share/ai-box.
  local here="" dir
  [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
  if [ -n "${AI_BOX_DIR:-}" ]; then dir=$AI_BOX_DIR
  elif [ -n "$here" ] && [ -e "$here/.git" ]; then dir=$here
  else dir="$HOME/.local/share/ai-box"
  fi
  if [ -e "$dir/.git" ]; then say "Using $dir"
  elif [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ]; then fail "$dir already exists and is not an AI Box checkout: move it away, then run the installer again."
  else say "Downloading AI Box into $dir"; git clone -q "$REPO_URL" "$dir"
  fi
  cd "$dir"
  dir=$(pwd)
  [ -z "${AI_BOX_REF:-}" ] || git checkout -q --detach "$AI_BOX_REF"

  if [ ! -f node_modules/electron/package.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    # The same commands as the app's own updates: npm ci leaves package-lock.json as it is (a local change would block
    # the Update button), and Electron's binary is fetched by its installer.
    say "Installing the dependencies (a few minutes)"
    npm ci --ignore-scripts --no-audit --no-fund </dev/null
  fi
  [ -f node_modules/electron/path.txt ] || node node_modules/electron/install.js </dev/null
  say "Building"
  npm run build </dev/null

  say "Creating the AI Box app"
  local open_cmd
  if [ "$(uname)" = Darwin ]; then
    local app="/Applications/AI Box.app" old="$HOME/Applications/AI Box.app"
    [ -w /Applications ] || app=$old
    sh scripts/macos-app.sh make "$app"
    # The first installer's launcher, in ~/Applications: replaced by the app above.
    if [ "$app" != "$old" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$old/Contents/Info.plist" 2>/dev/null)" = io.github.anilito1.hub.launcher ]; then
      rm -rf "$old"
    fi
    printf '\n\033[32m%s\033[0m\n' "AI Box is installed: open it from Applications or Launchpad."
    open_cmd=(open "$app")
  else
    sh scripts/linux-app.sh install
    printf '\n\033[32m%s\033[0m\n' "AI Box is installed: open it from your applications menu."
    open_cmd=(sh scripts/linux-app.sh launch)
    [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] || open_cmd=()
  fi
  if [ -z "${AI_BOX_NO_LAUNCH:-}" ] && [ "${#open_cmd[@]}" -gt 0 ]; then
    nohup "${open_cmd[@]}" >/dev/null 2>&1 &
  fi
}

# Everything runs from main, once the whole script is read: through `curl | bash`, a command reading its input would
# otherwise take the rest of the script.
main "$@"
