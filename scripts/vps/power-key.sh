#!/usr/bin/env bash
# Lets this server shelve itself when nothing has run on it for the user's delay, the PC being away (power.mjs).
# The AI Box runs it as the administrator, the key on stdin, from its memory (never in a file of the PC nor here):
#   ssh <admin>@<ip> sudo IDLE_HOURS=2 bash /opt/aibox/power-key.sh  < {"appKey","appSecret","consumerKey","project","instance"}
#   ssh <admin>@<ip> sudo REMOVE=1 bash /opt/aibox/power-key.sh       forgets it
#   ssh <admin>@<ip> sudo IDLE_ONLY=1 IDLE_HOURS=3 bash /opt/aibox/power-key.sh   changes the delay only
# The key is encrypted with this host's own key (systemd-creds, kept through a shelve) and only aibox-power.service
# gets it, in memory. aibox, whom the workers run as, cannot read it.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "run with sudo" >&2; exit 1; }
if [ "${REMOVE:-}" = 1 ]; then
  rm -f /etc/aibox/ovh.cred /etc/aibox/power.json
  echo removed
  exit 0
fi
[[ "${IDLE_HOURS:-}" =~ ^[0-9]{1,2}(\.[0-9]{1,2})?$ ]] || { echo "IDLE_HOURS (0.5 to 48) is missing" >&2; exit 1; }
# The delay changed in the app: the key stays as it is.
if [ "${IDLE_ONLY:-}" = 1 ]; then
  [ -f /etc/aibox/ovh.cred ] || { echo "no key here" >&2; exit 1; }
  printf '{"idleHours":%s}\n' "$IDLE_HOURS" >/etc/aibox/power.json
  echo stored
  exit 0
fi
umask 077
key="$(head -c 4096)"
[[ "$key" =~ ^\{\"appKey\":\"[A-Za-z0-9]{8,64}\",\"appSecret\":\"[A-Za-z0-9]{8,64}\",\"consumerKey\":\"[A-Za-z0-9]{8,64}\",\"project\":\"[a-z0-9-]{8,64}\",\"instance\":\"[a-z0-9-]{8,64}\"\}$ ]] || { echo "not an OVHcloud key" >&2; exit 1; }
printf '%s' "$key" | systemd-creds encrypt --with-key=host --name=ovh - /etc/aibox/ovh.cred.tmp
unset key
mv /etc/aibox/ovh.cred.tmp /etc/aibox/ovh.cred
chmod 600 /etc/aibox/ovh.cred
umask 022
printf '{"idleHours":%s}\n' "$IDLE_HOURS" >/etc/aibox/power.json
chmod 644 /etc/aibox/power.json
echo stored
