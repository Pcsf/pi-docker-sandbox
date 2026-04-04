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

# Rewrite localhost URLs in models.json to host.docker.internal so that
# local LLM servers (e.g. LM Studio) on the host are reachable from the container.
MODELS_FILE="/home/pi/.pi/agent/models.json"
if [ -f "$MODELS_FILE" ] && grep -q 'localhost' "$MODELS_FILE"; then
    sed -i 's|://localhost:|://host.docker.internal:|g' "$MODELS_FILE"
fi

# Pass all arguments to pi, or start interactive mode
if [ $# -eq 0 ]; then
    exec pi
else
    exec pi "$@"
fi
