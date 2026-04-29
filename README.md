# surveillance-node

Node.js implementation of the Raspberry Pi surveillance system (video stream, audio stream, talkback, camera/audio settings, HTTPS).

## Features

- MJPEG video streaming over WebSocket (`/video_feed`)
- Microphone PCM streaming over WebSocket (`/audio_feed`)
- Talkback WebSocket (`/ws/talk`) to server speakers
- Camera settings API (`/camera_settings`)
- Audio devices API (`/server_audio_devices`)
- Speaker volume API (`/speaker_volume`)
- HTTPS server with certificate/key

## Prerequisites

- Node.js 20+
- `ffmpeg`, `pulseaudio`, `pactl`, `parec`, `pacat`, `v4l2-ctl`
- Raspberry Pi camera/USB devices exposed on host

## Local Run

```bash
cd /home/eric/surveillance-node
cp .env.example .env
chmod +x scripts/gen-cert.sh
./scripts/gen-cert.sh
npm install
npm start
```

Open: `https://<pi-ip>:5000`

## Docker Run

```bash
cd /home/eric/surveillance-node
cp .env.example .env
chmod +x scripts/gen-cert.sh
./scripts/gen-cert.sh
sudo docker compose build
sudo docker compose up -d
```

Stop:

```bash
sudo docker compose down
```

## Notes

- Uses host network mode in Docker, so ensure port 5000 is free.
- CSI camera support requires `rpicam-vid`/`rpicam-hello` availability on host/container.
- Browser mic capture requires HTTPS and permission grant.
