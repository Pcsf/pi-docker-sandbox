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

# Create wrapper scripts for host tools mounted via --tools.
# Each wrapper invokes the host's dynamic linker with --library-path so that
# host binaries use host libraries without contaminating the container's libs.
if [ -n "${PI_HOST_TOOLS:-}" ]; then
    # Find the host's dynamic linker in /opt/host-tools/lib/
    HOST_LD=""
    for f in /opt/host-tools/lib/ld-linux-*.so.*; do
        [ -f "$f" ] && HOST_LD="$f" && break
    done

    IFS=',' read -ra TOOLS <<< "$PI_HOST_TOOLS"
    for tool in "${TOOLS[@]}"; do
        real_bin="/opt/host-tools/real/${tool}"
        wrapper="/opt/host-tools/bin/${tool}"
        [ -f "$real_bin" ] || continue

        # Detect if this tool needs PYTHONHOME (links libpython)
        ENV_EXPORTS=""
        if ls /opt/host-tools/lib/libpython*.so* &>/dev/null; then
            for pydir in /usr/lib/python[0-9]*/; do
                if [ -d "$pydir" ]; then
                    ENV_EXPORTS="export PYTHONHOME=/usr"
                    break
                fi
            done
        fi

        if [ -n "$HOST_LD" ]; then
            cat > "$wrapper" <<WRAP
#!/bin/sh
${ENV_EXPORTS}
exec "$HOST_LD" --library-path /opt/host-tools/lib "$real_bin" "\$@"
WRAP
        else
            # Static binary or no ld-linux found — run directly
            cat > "$wrapper" <<WRAP
#!/bin/sh
${ENV_EXPORTS}
exec "$real_bin" "\$@"
WRAP
        fi
        chmod +x "$wrapper"
    done
    export PATH="/opt/host-tools/bin:${PATH}"
fi

# Pass all arguments to pi, or start interactive mode
if [ $# -eq 0 ]; then
    exec pi
else
    exec pi "$@"
fi
