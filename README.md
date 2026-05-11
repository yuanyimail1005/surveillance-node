# surveillance-node

Node.js implementation of the Raspberry Pi surveillance system with browser-based live video/audio, two-way talkback, camera and audio controls, snapshot capture, video recording, and server-side face recognition.

The app serves a single HTTPS web UI and streams media over WebSocket endpoints.

## Features

- Live MJPEG video streaming over WebSocket
- Live microphone audio streaming from the server to the browser
- Two-way talkback from browser microphone to server speakers
- Camera resolution, FPS, device selection, and rotation controls
- Server microphone and speaker device selection
- Speaker volume control
- Snapshot capture and browser-side video recording
- Server-side face detection and known-face recognition
- Face overlay synchronized to streamed video frames
- HTTPS/WSS transport for browser microphone access and secure remote use

## Face Recognition

Face recognition runs on the server using `@vladmandic/face-api` with `@tensorflow/tfjs-node`.

Current Node backend details:

- Backend label in the UI: `face-api.js`
- Detection model: SSD MobileNet v1
- Landmark model: 68-point face landmarks
- Recognition model: face-api recognition net
- Matching method: descriptor distance against a known-faces directory

Known faces are loaded from `FACE_RECOGNITION_KNOWN_FACES_DIR`, with one subdirectory per person and JPEG/PNG files inside each subdirectory.

Example:

```text
known_faces/
	Alice/
		alice1.jpg
		alice2.png
	Bob/
		bob_front.jpg
```

On first load, descriptors are computed and cached in `.face_descriptor_cache.json` inside the known-faces directory.

## Prerequisites

### Local runtime

- Linux host, typically Raspberry Pi OS / Debian Bookworm
- Node.js 20 recommended
- `ffmpeg`
- `pulseaudio` and `pulseaudio-utils`
- `v4l2-ctl`
- Camera devices available on the host (`/dev/video*` or CSI via `rpicam-apps`)

For local installs on `arm64`, `@tensorflow/tfjs-node` may need to build its native addon from source. If the addon was installed for the wrong architecture, rebuild it with:

```bash
cd /home/eric/surveillance-node/node_modules/@tensorflow/tfjs-node
npm run build-addon-from-source
```

### Browser requirements

- A modern Chromium-based browser is recommended
- HTTPS is required for browser microphone access
- The browser must be allowed to access the microphone for talkback

## Configuration

Copy the example environment file first:

```bash
cd /home/eric/surveillance-node
cp .env.example .env
```

Important variables in `.env`:

| Variable | Default | Description |
|---|---|---|
| `SERVER_HOST` | `0.0.0.0` | Address the HTTPS server binds to |
| `SERVER_PORT` | `5000` | HTTPS port |
| `SSL_CERT_PATH` | `./cert.pem` | TLS certificate path |
| `SSL_KEY_PATH` | `./key.pem` | TLS key path |
| `CAMERA_DEVICE` | `/dev/video0` | Default V4L2 camera device |
| `CAMERA_WIDTH` / `CAMERA_HEIGHT` | `1920` / `1080` | Default capture resolution |
| `CAMERA_FPS` | `25` | Default capture FPS |
| `PULSE_SINK_NAME` | `@DEFAULT_SINK@` | PulseAudio output sink |
| `PULSE_CAPTURE_SOURCE_NAME` | `@DEFAULT_SOURCE@` | PulseAudio capture source |
| `TALKBACK_PLAYBACK_GAIN` | `5.0` | Gain applied to talkback audio |
| `FACE_RECOGNITION_ENABLED` | `false` | Start with face recognition enabled or disabled |
| `FACE_RECOGNITION_KNOWN_FACES_DIR` | `./known_faces` | Directory of known faces |
| `FACE_RECOGNITION_DETECT_EVERY_N_FRAMES` | unset | Detection interval in frames; unset means auto |
| `FACE_RECOGNITION_MATCH_THRESHOLD` | `0.6` | Match threshold, lower is stricter |
| `FACE_RECOGNITION_MAX_FACES` | `8` | Maximum faces processed per frame |
| `FACE_RECOGNITION_MODELS_DIR` | unset | Override face-api model directory |

By default, the UI can enable face recognition at runtime even if `FACE_RECOGNITION_ENABLED=false` at startup.

## Generate TLS Certificate

If you do not already have a certificate and key, generate a self-signed pair:

```bash
cd /home/eric/surveillance-node
chmod +x scripts/gen-cert.sh
./scripts/gen-cert.sh
```

This creates `cert.pem` and `key.pem` in the project root.

## Local Run

Install dependencies and start the server:

```bash
cd /home/eric/surveillance-node
cp .env.example .env
chmod +x scripts/gen-cert.sh
./scripts/gen-cert.sh
npm install
npm start
```

Open:

```text
https://<host-or-pi-ip>:5000
```

## Docker

Docker Compose is supported and uses host networking so the container binds directly to the host port.

### Build

```bash
cd /home/eric/surveillance-node
sudo docker compose build
```

### Start

```bash
sudo docker compose up -d
```

### Stop

```bash
sudo docker compose down
```

### Logs

```bash
sudo docker compose logs -f surveillance-node
```

### Docker notes

- The container uses `network_mode: host`, so port `5000` must be free on the host.
- The image installs `rpicam-apps`, `ffmpeg`, PulseAudio tools, and V4L2 utilities.
- TLS cert and key are mounted into `/app/cert.pem` and `/app/key.pem`.
- Device access is granted through `/dev`, `/dev/snd`, and the `audio` / `video` groups.
- If you want face recognition in Docker, mount your known-faces directory into the container and set `FACE_RECOGNITION_KNOWN_FACES_DIR` to the in-container path. The current compose file does not mount a known-faces directory by default.

Example additional volume mapping for Docker face recognition:

```yaml
volumes:
	- /home/eric/known_faces:/known_faces:ro
```

With matching `.env` value:

```bash
FACE_RECOGNITION_KNOWN_FACES_DIR=/known_faces
```

## Web UI

The browser UI includes:

- Live video with synchronized face overlays
- Start/stop listening to server audio
- Start/stop talkback from browser microphone
- Camera rotation, resolution, FPS, and device controls
- Snapshot capture
- Video recording
- Server microphone and speaker selection
- Speaker volume control
- Face recognition enable/disable toggle and backend status panel
- System status and frame-sync diagnostics

## API Summary

Main HTTP endpoints:

- `GET /status`
- `GET /camera_settings`
- `POST /camera_settings`
- `GET /server_audio_devices`
- `POST /server_audio_devices/select`
- `GET /speaker_volume`
- `POST /speaker_volume`
- `GET /face_status`
- `POST /face_settings`

Main WebSocket endpoints:

- `/video_feed`
- `/audio_feed`
- `/ws/talk`

## Troubleshooting

### Face recognition stuck loading or unavailable

Check the face status API:

```bash
curl -sk https://127.0.0.1:5000/face_status
```

If `tfjs-node` was installed for the wrong architecture, rebuild it from source:

```bash
cd /home/eric/surveillance-node/node_modules/@tensorflow/tfjs-node
npm run build-addon-from-source
```

### No known faces loaded

Make sure:

- `FACE_RECOGNITION_KNOWN_FACES_DIR` points to the correct directory
- each person has their own subdirectory
- images are JPEG or PNG
- the process can read the directory

You can remove the generated cache to force descriptor regeneration:

```bash
rm -f /path/to/known_faces/.face_descriptor_cache.json
```

### Browser microphone does not work

Make sure:

- the site is opened over HTTPS
- microphone permission is granted in the browser
- PulseAudio devices are available on the host

### Docker face recognition sees zero profiles

If Docker starts successfully but face recognition reports zero known faces, the known-faces directory is probably not mounted into the container. Add a volume mapping and point `FACE_RECOGNITION_KNOWN_FACES_DIR` to the container path.
