const path = require('path');
const dotenv = require('dotenv');

dotenv.config();

const toInt = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toFloat = (value, fallback) => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const toBool = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  return String(value).toLowerCase() === 'true';
};

module.exports = {
  serverHost: process.env.SERVER_HOST || '0.0.0.0',
  serverPort: toInt(process.env.SERVER_PORT, 5000),
  sslCertPath: path.resolve(process.env.SSL_CERT_PATH || './cert.pem'),
  sslKeyPath: path.resolve(process.env.SSL_KEY_PATH || './key.pem'),

  cameraDevice: process.env.CAMERA_DEVICE || '/dev/video0',
  cameraWidth: toInt(process.env.CAMERA_WIDTH, 1920),
  cameraHeight: toInt(process.env.CAMERA_HEIGHT, 1080),
  cameraFps: toInt(process.env.CAMERA_FPS, 25),

  sampleRate: toInt(process.env.SAMPLE_RATE, 48000),
  micChannels: toInt(process.env.MIC_CHANNELS, 1),
  speakerChannels: toInt(process.env.SPEAKER_CHANNELS, 2),
  pulseSinkName: process.env.PULSE_SINK_NAME || '@DEFAULT_SINK@',
  pulseCaptureSourceName: process.env.PULSE_CAPTURE_SOURCE_NAME || '@DEFAULT_SOURCE@',
  talkbackPlaybackGain: toFloat(process.env.TALKBACK_PLAYBACK_GAIN, 5.0),

  videoAllowedResolutions: [
    [640, 480],
    [1280, 720],
    [1920, 1080],
    [2560, 1440]
  ],
  videoMinFps: 1,
  videoMaxFps: 60,

  faceRecognitionEnabled: toBool(process.env.FACE_RECOGNITION_ENABLED, false),
  faceRecognitionKnownFacesDir: path.resolve(process.env.FACE_RECOGNITION_KNOWN_FACES_DIR || './known_faces'),
  // null = auto: detect every ~0.5s based on cameraFps; set an integer to force a fixed interval
  faceRecognitionDetectEveryNFrames: process.env.FACE_RECOGNITION_DETECT_EVERY_N_FRAMES
    ? toInt(process.env.FACE_RECOGNITION_DETECT_EVERY_N_FRAMES, null)
    : null,
  faceRecognitionMatchThreshold: toFloat(process.env.FACE_RECOGNITION_MATCH_THRESHOLD, 0.6),
  faceRecognitionMaxFaces: toInt(process.env.FACE_RECOGNITION_MAX_FACES, 8),
  faceRecognitionModelsDir: process.env.FACE_RECOGNITION_MODELS_DIR
    ? path.resolve(process.env.FACE_RECOGNITION_MODELS_DIR)
    : path.resolve(__dirname, '../node_modules/@vladmandic/face-api/model')
};
