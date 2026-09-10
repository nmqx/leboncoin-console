#!/bin/sh
set -eu

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

# Préserve toutes les autres tâches et remplace seulement notre bloc balisé.
(crontab -l 2>/dev/null || true) | awk '
  /^# BEGIN LBC_CONSOLE$/ { skip = 1; next }
  /^# END LBC_CONSOLE$/ { skip = 0; next }
  !skip { print }
' > "$tmp"

cat >> "$tmp" <<'EOF'
# BEGIN LBC_CONSOLE
@reboot /home/nrk/lbc/deploy/lbc-start.sh >> /home/nrk/lbc-start.log 2>&1
*/2 * * * * /home/nrk/lbc/deploy/lbc-watchdog.sh >> /home/nrk/lbc-watchdog.log 2>&1
# END LBC_CONSOLE
EOF

crontab "$tmp"
