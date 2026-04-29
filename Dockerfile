FROM node:20-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

RUN set -eux; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg; \
    mkdir -p /etc/apt/keyrings; \
    curl -fsSL https://archive.raspberrypi.com/debian/raspberrypi.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/raspberrypi-archive-keyring.gpg; \
    echo "deb [signed-by=/etc/apt/keyrings/raspberrypi-archive-keyring.gpg] http://archive.raspberrypi.com/debian/ bookworm main" \
      > /etc/apt/sources.list.d/raspi.list; \
    apt-get update; \
    if ! apt-cache show rpicam-apps >/dev/null 2>&1; then \
      echo "rpicam-apps package still not found after enabling Raspberry Pi repository" >&2; \
      exit 1; \
    fi; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ffmpeg \
      pulseaudio \
      pulseaudio-utils \
      v4l-utils \
      rpicam-apps; \
    rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

EXPOSE 5000
CMD ["node", "src/server.js"]
