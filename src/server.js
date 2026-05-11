const fs = require('fs');
const https = require('https');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const { serverHost, serverPort, sslCertPath, sslKeyPath,
  cameraFps,
  faceRecognitionEnabled, faceRecognitionKnownFacesDir, faceRecognitionDetectEveryNFrames,
  faceRecognitionMatchThreshold, faceRecognitionMaxFaces, faceRecognitionModelsDir
} = require('./config');
const media = require('./media');
const { FaceRecognitionService } = require('./face');

// Face recognition: auto-detect interval (~0.5 s) if not explicitly configured.
const detectEveryNFrames = faceRecognitionDetectEveryNFrames !== null
  ? faceRecognitionDetectEveryNFrames
  : Math.max(1, Math.round(cameraFps / 2));

const faceService = new FaceRecognitionService({
  enabled: faceRecognitionEnabled,
  knownFacesDir: faceRecognitionKnownFacesDir,
  detectEveryNFrames,
  matchThreshold: faceRecognitionMatchThreshold,
  maxFaces: faceRecognitionMaxFaces,
  modelsDir: faceRecognitionModelsDir
});

// Forward face results to all active video subscribers as JSON text messages.
faceService.on('result', (status) => {
  media.broadcastVideoJson({ type: 'face_data', ...status });
});

// Only feed frames to the face service when at least one client is connected.
media.setVideoFrameHook((buf, seq) => {
  media.broadcastVideoJson({ type: 'frame_meta', broadcast_frame_seq: seq });
  if (media.state.videoSubscribers.size === 0) return;
  faceService.processFrame(buf, seq);
});

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

app.get('/face_status', (req, res) => {
  res.json(faceService.getStatus());
});

app.post('/face_settings', (req, res) => {
  const body = req.body || {};
  if (!('enabled' in body)) {
    res.status(400).json({ status: 'error', message: 'Provide "enabled" (boolean) in request body' });
    return;
  }
  faceService.setEnabled(Boolean(body.enabled));
  res.json({ status: 'ok', ...faceService.getStatus() });
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

const cleanupWs = (ws) => {
  if (ws.pathName === '/video_feed') {
    media.unsubscribeVideo(ws);
    return;
  }
  if (ws.pathName === '/audio_feed') {
    media.unsubscribeAudio(ws);
  }
};

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.pathName = request.url;
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  ws.on('close', () => {
    cleanupWs(ws);
  });

  ws.on('error', () => {
    cleanupWs(ws);
  });

  if (ws.pathName === '/video_feed') {
    media.subscribeVideo(ws);
    return;
  }

  if (ws.pathName === '/audio_feed') {
    media.subscribeAudio(ws);
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

// Initialize face recognition service in background (non-blocking).
faceService.init().catch((err) => console.error('Face recognition startup error:', err));

server.listen(serverPort, serverHost, () => {
  console.log(`Server: https://${serverHost}:${serverPort}`);
});

const gracefulShutdown = (signal) => {
  console.log(`Received ${signal}, shutting down…`);

  // Stop accepting new HTTP/WS connections.
  server.close(() => {
    console.log('HTTPS server closed.');
  });

  // Terminate every open WebSocket connection.
  for (const ws of wss.clients) {
    try { ws.terminate(); } catch (_) {}
  }

  // Close the WebSocket server.
  wss.close(() => {
    console.log('WebSocket server closed.');
  });

  // Stop all media child processes and suppress auto-restart.
  media.shutdown();
  faceService.shutdown();

  // Force exit after 5 s if anything hangs.
  const forced = setTimeout(() => {
    console.error('Forced exit after timeout.');
    process.exit(1);
  }, 5000);
  if (forced.unref) forced.unref();
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGHUP',  () => gracefulShutdown('SIGHUP'));
