const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { serverHost, serverPort, sslCertPath, sslKeyPath } = require('./config');
const media = require('./media');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.resolve(__dirname, '../public')));

app.get('/status', (req, res) => {
  res.json(media.getStatus());
});

app.get('/camera_settings', (req, res) => {
  res.json(media.getCameraSettingsPayload());
});

app.post('/camera_settings', (req, res) => {
  const result = media.applyCameraSettings(req.body || {});
  if (!result.ok) {
    res.status(result.code).json({ status: 'error', message: result.message });
    return;
  }
  res.json(result.payload);
});

app.get('/server_audio_devices', (req, res) => {
  res.json({
    status: 'ok',
    microphones: media.listCaptureDevices(),
    speakers: media.listOutputSinks(),
    selected_microphone: media.state.pulseCaptureSourceName,
    selected_speaker: media.state.pulseSinkName
  });
});

app.post('/server_audio_devices/select', (req, res) => {
  res.json(media.selectServerAudioDevices(req.body || {}));
});

app.get('/speaker_volume', (req, res) => {
  const volume = media.getSpeakerVolume();
  if (volume === null) {
    res.status(500).json({ status: 'error', message: 'Could not read speaker volume via pactl', available: false });
    return;
  }
  res.json({ status: 'ok', available: true, volume, control: 'pactl' });
});

app.post('/speaker_volume', (req, res) => {
  const volume = Number.parseInt((req.body || {}).volume, 10);
  if (!Number.isFinite(volume)) {
    res.status(400).json({ status: 'error', message: 'Volume must be an integer' });
    return;
  }
  const normalized = Math.max(0, Math.min(100, volume));
  const ok = media.setSpeakerVolume(normalized);
  if (!ok) {
    res.status(500).json({ status: 'error', message: 'Could not set speaker volume via pactl' });
    return;
  }
  res.json({ status: 'ok', volume: normalized, control: 'pactl' });
});

let cert;
let key;
try {
  cert = fs.readFileSync(sslCertPath);
  key = fs.readFileSync(sslKeyPath);
} catch (err) {
  console.error(`Missing SSL cert/key. Expected ${sslCertPath} and ${sslKeyPath}`);
  process.exit(1);
}

const server = https.createServer({ cert, key }, app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.pathName = request.url;
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  if (ws.pathName === '/video_feed') {
    media.subscribeVideo(ws);
    ws.on('close', () => media.unsubscribeVideo(ws));
    return;
  }

  if (ws.pathName === '/audio_feed') {
    media.subscribeAudio(ws);
    ws.on('close', () => media.unsubscribeAudio(ws));
    return;
  }

  if (ws.pathName === '/ws/talk') {
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      media.writeTalkback(Buffer.from(data));
    });
    return;
  }

  ws.close(1008, 'Unsupported websocket path');
});

media.ensureStarted();

server.listen(serverPort, serverHost, () => {
  console.log(`Server: https://${serverHost}:${serverPort}`);
});
