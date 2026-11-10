#!/usr/bin/env bash
# Clones or updates, in ~aibox/repos, the repos the AI Box may run on the server. Run as aibox, by the setup:
#   printf '%s\n' "$TOKEN" | sudo -u aibox -H bash /opt/aibox/repos.sh '<git name>' '<git email>' owner/repo ...
# The user's GitHub token comes on the first line of the input: it is used for this run only and never written (git
# reads it from the environment through a credential helper that holds no secret; workers get it the same way, from
# the hub, at each launch). Only the repos of /etc/aibox/repos (root's, written by the setup from the user's list).
# Prints one line per repo:
#   REPO <owner/name> ready     cloned (or fetched) and up to date
#   REPO <owner/name> refused   GitHub refused the token for it (not among the token's repos)
set -uo pipefail
[ "$(id -un)" = aibox ] || { echo "run as aibox" >&2; exit 1; }
[ $# -ge 2 ] || { echo "usage: repos.sh <git name> <git email> <owner/name>..." >&2; exit 1; }
IFS= read -r GH_TOKEN || true
export GH_TOKEN
NAME="$1"
EMAIL="$2"
shift 2
umask 077
mkdir -p ~/repos
[[ "$NAME" =~ ^[A-Za-z0-9\ ._-]{1,80}$ ]] && git config --global user.name "$NAME"
[[ "$EMAIL" =~ ^[A-Za-z0-9.+_-]+@[A-Za-z0-9.-]+$ ]] && git config --global user.email "$EMAIL"
git config --global pull.ff only
git config --global init.defaultBranch main
# The token from the environment of whoever runs git (this script, a worker): the helper itself holds no secret.
git config --global --replace-all credential.https://github.com.helper ''
git config --global --add credential.https://github.com.helper '!f() { test "$1" = get && test -n "$GH_TOKEN" && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f'

# Deploy keys of an earlier setup: no longer used, removed with their SSH aliases.
rm -f ~/.ssh/deploy_* 2>/dev/null
if [ -f ~/.ssh/config ]; then
  awk '/^Host github-/{skip=1; next} /^Host /{skip=0} !skip' ~/.ssh/config >~/.ssh/config.new && mv ~/.ssh/config.new ~/.ssh/config
fi

for slug in "$@"; do
  [[ "$slug" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] && grep -qxF -- "$slug" /etc/aibox/repos || { echo "SKIP $slug (not listed)"; continue; }
  dir="$HOME/repos/${slug#*/}"
  url="https://github.com/$slug.git"
  state=refused
  if [ -d "$dir/.git" ]; then
    git -C "$dir" remote set-url origin "$url"
    if out=$(GIT_TERMINAL_PROMPT=0 git -C "$dir" fetch --prune origin </dev/null 2>&1); then state=ready; else echo "fetch $slug: ${out##*$'\n'}"; fi
  # Without the old files' contents (fetched when a checkout needs them): a large repo clones in seconds, history kept.
  elif out=$(GIT_TERMINAL_PROMPT=0 git clone -q --filter=blob:none "$url" "$dir" </dev/null 2>&1); then
    state=ready
  else
    echo "clone $slug: ${out##*$'\n'}"
  fi
  echo "REPO $slug $state"
done
