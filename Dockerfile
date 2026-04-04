FROM node:22-slim

RUN apt-get update && \
    apt-get install -y --no-install-recommends git jq curl ca-certificates && \
    curl -fsSL https://github.com/BurntSushi/ripgrep/releases/download/14.1.1/ripgrep-14.1.1-x86_64-unknown-linux-musl.tar.gz \
      | tar xz -C /usr/local/bin --strip-components=1 ripgrep-14.1.1-x86_64-unknown-linux-musl/rg && \
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN npm config set fund false && \
    npm config set update-notifier false && \
    npm config set loglevel error && \
    npm install -g @mariozechner/pi-coding-agent@0.65.0 && \
    npm cache clean --force

RUN usermod -l pi -d /home/pi -m node && \
    groupmod -n pi node && \
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
