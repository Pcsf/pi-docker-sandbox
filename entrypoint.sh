#!/usr/bin/env bash
set -euo pipefail

# Ensure PI config directory structure exists
mkdir -p /home/pi/.pi/agent

# If auth.json was not mounted, create an empty one
if [ ! -f /home/pi/.pi/agent/auth.json ]; then
    echo '{}' > /home/pi/.pi/agent/auth.json
    chmod 600 /home/pi/.pi/agent/auth.json
fi

# If models.json was not mounted, skip (PI works without it)

# Pass all arguments to pi, or start interactive mode
if [ $# -eq 0 ]; then
    exec pi
else
    exec pi "$@"
fi
