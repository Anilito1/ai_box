#!/usr/bin/env bash
# Prepares a fresh Ubuntu 24.04 server for the AI Box's remote workers (experimental, phase 1).
# Idempotent: run it again after a change, it only does what is missing.
#
#   (the AI Box's Settings › Remote server copies setup.sh, launch.mjs and repos.sh to the server and runs this)
#   ssh <admin>@<ip> sudo WORKER_KEY="ssh-ed25519 AAAA… aibox-hub-worker" bash /tmp/setup.sh
#
# What it does:
#   - SSH: keys only, no root, no password, only the admin user and aibox may log in; the authorized keys live in
#     /etc/ssh/authorized_keys/<user>, owned by root: a worker (aibox) cannot lift the lock on its own key;
#   - firewall: everything incoming refused except SSH (22); fail2ban on SSH; security updates daily;
#   - user aibox, without sudo: its SSH key only runs /opt/aibox/launch.mjs (no shell); ~/repos holds the clones;
#   - Node LTS, git, Claude Code (for aibox, in ~/.local/bin). Signing in and cloning come after, by hand.
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
ADMIN="${ADMIN:-${SUDO_USER:-}}"
[[ "$ADMIN" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$ADMIN" != root ] && [ "$ADMIN" != aibox ] || { echo "ADMIN (the user you log in with, not root nor aibox) is unknown: ADMIN=<name>" >&2; exit 1; }
[ -n "${WORKER_KEY:-}" ] || { echo "WORKER_KEY (public key of the AI Box) is missing" >&2; exit 1; }
[[ "$WORKER_KEY" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ [A-Za-z0-9@._-]+)?$ ]] || { echo "WORKER_KEY is not one ssh-ed25519 public key" >&2; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"
for f in launch.mjs repos.sh envsync.mjs tools.sh; do [ -f "$HERE/$f" ] || { echo "$f must sit next to setup.sh" >&2; exit 1; }; done
# The admin must keep a way in before SSH is narrowed.
[ -s "/home/$ADMIN/.ssh/authorized_keys" ] || { echo "/home/$ADMIN/.ssh/authorized_keys is empty: refusing to lock SSH" >&2; exit 1; }

step() { printf '\n== %s\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

step "packages"
apt-get -o DPkg::Lock::Timeout=600 update -qq
apt-get install -o DPkg::Lock::Timeout=600 -y -qq git gh curl ca-certificates ufw fail2ban unattended-upgrades >/dev/null

step "Node LTS"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  # A name nobody else can take in /tmp: root runs it.
  ns="$(mktemp)"
  curl -fsSL https://deb.nodesource.com/setup_lts.x -o "$ns"
  bash "$ns" >/dev/null
  rm -f "$ns"
  apt-get install -o DPkg::Lock::Timeout=600 -y -qq nodejs >/dev/null
fi
node --version

step "security updates every day"
cat >/etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
systemctl enable --now unattended-upgrades >/dev/null

step "swap (2 GB, if none)"
if ! swapon --show | grep -q .; then
  [ -f /swapfile ] || fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

step "user aibox (no sudo)"
id aibox >/dev/null 2>&1 || adduser --disabled-password --gecos 'AI Box workers' aibox >/dev/null
for g in sudo adm lxd docker; do gpasswd -d aibox "$g" >/dev/null 2>&1 || true; done
chmod 750 /home/aibox
install -d -m 755 -o root -g root /opt/aibox /etc/aibox
# The repos the workers may touch: written by the AI Box's setup (its repos step), root's, read by the launcher.
[ -f /etc/aibox/repos ] || install -m 644 -o root -g root /dev/null /etc/aibox/repos
install -m 644 -o root -g root "$HERE/repos.sh" /opt/aibox/repos.sh
install -d -m 700 -o aibox -g aibox /home/aibox/.ssh /home/aibox/repos /home/aibox/.aibox
# Root's files, read by sshd only: the admin's keys as they are now, and the AI Box's, which runs the launcher and
# nothing else (no shell, no forwarding, no terminal). Not in ~/.ssh, where aibox could rewrite them.
install -d -m 755 -o root -g root /etc/ssh/authorized_keys
install -m 644 -o root -g root "/home/$ADMIN/.ssh/authorized_keys" "/etc/ssh/authorized_keys/$ADMIN"
echo "command=\"/usr/bin/node /opt/aibox/launch.mjs\",restrict $WORKER_KEY" >/etc/ssh/authorized_keys/aibox
chmod 644 /etc/ssh/authorized_keys/aibox
rm -f /home/aibox/.ssh/authorized_keys

step "Claude Code for aibox"
if [ ! -x /home/aibox/.local/bin/claude ]; then
  # Not `sudo -i`: it hands the command to a login shell that expands its $variables first, empty.
  sudo -u aibox -H bash -c 'cd ~ && f="$(mktemp)" && curl -fsSL https://claude.ai/install.sh -o "$f" && bash "$f" && rm -f "$f"' >/dev/null
fi
sudo -iu aibox /home/aibox/.local/bin/claude --version
grep -q '.local/bin' /home/aibox/.profile || echo 'export PATH="$HOME/.local/bin:$PATH"' >>/home/aibox/.profile

step "SSH: keys only, no root, two users"
passwd -l root >/dev/null
cat >/etc/ssh/sshd_config.d/10-aibox.conf <<EOF
# Read before the cloud image's own files: the first value wins.
PubkeyAuthentication yes
AuthorizedKeysFile /etc/ssh/authorized_keys/%u
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
AllowUsers $ADMIN aibox
X11Forwarding no
LoginGraceTime 30
EOF
# Ubuntu 24.04 starts sshd from a socket: its runtime folder may not exist between connections.
install -d -m 755 /run/sshd
sshd -t
# A running daemon reads the new rules now; a socket-started one reads them at the next connection.
if systemctl is-active --quiet ssh; then systemctl reload ssh; fi

step "firewall: SSH only"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
# Allowed, not rate-limited: the hub opens one connection per session start and per transcript read.
ufw allow 22/tcp comment SSH >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed -n '1,12p'

step "fail2ban on SSH"
cat >/etc/fail2ban/jail.d/aibox.local <<'EOF'
[sshd]
enabled = true
backend = systemd
maxretry = 4
findtime = 10m
bantime = 6h
EOF
systemctl enable fail2ban >/dev/null
systemctl restart fail2ban
sleep 2
fail2ban-client status sshd | sed -n '1,4p'

step "environment sync and tools"
# Before the launcher: its environment requests load envsync.mjs. A tool that fails does not stop the setup.
install -m 644 -o root -g root "$HERE/envsync.mjs" /opt/aibox/envsync.mjs
bash "$HERE/tools.sh" || echo "tools.sh failed: the server works without the missing tools"

step "launcher"
# Last: the app sees its version only once everything above went through, so a stopped run is run again.
install -m 644 -o root -g root "$HERE/launch.mjs" /opt/aibox/launch.mjs

step "done"
echo "Next (the AI Box does it): sign Claude Code in for aibox, then /opt/aibox/repos.sh for the clones (with your token, in memory)."
