FROM archlinux:latest

RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm --needed \
        nodejs npm git jq ripgrep ca-certificates \
        octave && \
    pacman -Scc --noconfirm && \
    rm -rf /var/cache/pacman/pkg/* /var/lib/pacman/sync/*

# Install pi agent to /opt/pi-agent instead of /usr so it survives the
# --host-apps mode's /usr overlay. Produces /opt/pi-agent/bin/pi that's
# on PATH below.
RUN npm config set fund false && \
    npm config set update-notifier false && \
    npm config set loglevel error && \
    npm install -g --prefix /opt/pi-agent @earendil-works/pi-coding-agent@0.77.0 && \
    npm cache clean --force

RUN useradd -m -s /bin/bash -u 1000 pi && \
    mkdir -p /home/pi/.pi/agent /home/pi/.npm-global /pi-npm-global /pi-npm-cache /workspace /repos && \
    chown -R pi:pi /home/pi /pi-npm-global /pi-npm-cache /workspace /repos && \
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
