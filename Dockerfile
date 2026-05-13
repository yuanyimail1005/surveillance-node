FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      g++ \
      make \
      pkg-config \
      python3; \
    arch="$(dpkg --print-architecture)"; \
    if [ "$arch" = "arm64" ] || [ "$arch" = "armhf" ]; then \
      mkdir -p /etc/apt/keyrings; \
      curl -fsSL https://archive.raspberrypi.com/debian/raspberrypi.gpg.key \
        | gpg --dearmor -o /etc/apt/keyrings/raspberrypi-archive-keyring.gpg; \
      echo "deb [signed-by=/etc/apt/keyrings/raspberrypi-archive-keyring.gpg] http://archive.raspberrypi.com/debian/ bookworm main" \
        > /etc/apt/sources.list.d/raspi.list; \
      apt-get update; \
      if ! apt-cache show rpicam-apps >/dev/null 2>&1; then \
        echo "rpicam-apps package not found on $arch after enabling Raspberry Pi repository" >&2; \
        exit 1; \
      fi; \
      RPICAM_PKG="rpicam-apps"; \
    else \
      RPICAM_PKG=""; \
      echo "Skipping rpicam-apps install on non-Raspberry-Pi architecture: $arch"; \
    fi; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg \
      pulseaudio \
      pulseaudio-utils \
      v4l-utils \
      ${RPICAM_PKG:+$RPICAM_PKG}; \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN set -eux; \
    npm install --omit=dev; \
    node -e "require('@tensorflow/tfjs-node')" || \
      (cd node_modules/@tensorflow/tfjs-node && npm run build-addon-from-source); \
    node -e "require('@tensorflow/tfjs-node')"

COPY . .

EXPOSE 5000
CMD ["node", "src/server.js"]
