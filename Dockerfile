FROM archlinux:latest

RUN pacman -Syu --noconfirm && \
    pacman -S --noconfirm --needed \
        nodejs npm git jq ripgrep ca-certificates && \
    pacman -Scc --noconfirm && \
    rm -rf /var/cache/pacman/pkg/* /var/lib/pacman/sync/*

RUN npm config set fund false && \
    npm config set update-notifier false && \
    npm config set loglevel error && \
    npm install -g @mariozechner/pi-coding-agent@0.66.1 && \
    npm cache clean --force

RUN useradd -m -s /bin/bash -u 1000 pi && \
    mkdir -p /home/pi/.pi/agent /home/pi/.npm-global /workspace /repos && \
    chown -R pi:pi /home/pi /workspace /repos

COPY --chown=pi:pi entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER pi
WORKDIR /workspace

RUN npm config set fund false && \
    npm config set update-notifier false && \
    npm config set loglevel error

ENV NPM_CONFIG_PREFIX=/home/pi/.npm-global
ENV PATH="/home/pi/.npm-global/bin:${PATH}"
ENV HOME=/home/pi

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
