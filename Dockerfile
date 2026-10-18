FROM archlinux:latest

RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm --needed \
        nodejs npm git jq ripgrep ca-certificates \
        openssh github-cli \
        octave && \
    pacman -Scc --noconfirm && \
    rm -rf /var/cache/pacman/pkg/* /var/lib/pacman/sync/*

# Install pi agent to /opt/pi-agent instead of /usr so it survives the
# --host-apps mode's /usr overlay. Produces /opt/pi-agent/bin/pi that's
# on PATH below.
RUN npm config set fund false && \
    npm config set update-notifier false && \
    npm config set loglevel error && \
    npm install -g --prefix /opt/pi-agent @earendil-works/pi-coding-agent@1.3.0 && \
    npm cache clean --force

# LifeOS ships its tooling as TypeScript run with bun, so the LifeOS adapter is
# degraded without it. Not in Arch's repos; the npm package is a stub whose
# postinstall fetches the real binary. That postinstall does not run under a
# global root install, leaving a bun that exits 1 on every invocation, so it is
# invoked explicitly here. The version check fails the build rather than
# shipping a broken bun.
RUN npm install -g --prefix /opt/pi-agent bun@1.4.0 && \
    node /opt/pi-agent/lib/node_modules/bun/install.js && \
    /opt/pi-agent/bin/bun --version && \
    npm cache clean --force

# /home/pi is 0755, not useradd's default 0700. Under rootless Docker the
# invoking user maps to uid 0, which runs without CAP_DAC_OVERRIDE once
# capabilities are dropped and so cannot traverse a 0700 home.
RUN useradd -m -s /bin/bash -u 1000 pi && \
    mkdir -p /home/pi/.pi/agent /home/pi/.npm-global /pi-npm-global /pi-npm-cache /workspace /repos && \
    chown -R pi:pi /home/pi /pi-npm-global /pi-npm-cache /workspace /repos && \
    chmod 0755 /home/pi && \
    chmod 0777 /pi-npm-global /pi-npm-cache

COPY --chown=pi:pi entrypoint.sh /pi-entrypoint.sh
RUN chmod +x /pi-entrypoint.sh

USER pi
WORKDIR /workspace

RUN npm config set fund false && \
    npm config set update-notifier false && \
    npm config set loglevel error

ENV NPM_CONFIG_PREFIX=/home/pi/.npm-global
ENV PATH="/opt/pi-agent/bin:/home/pi/.npm-global/bin:${PATH}"
ENV NODE_PATH="/opt/pi-agent/lib/node_modules:/home/pi/.npm-global/lib/node_modules"
ENV HOME=/home/pi

ENTRYPOINT ["/pi-entrypoint.sh"]
