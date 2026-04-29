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
  videoMaxFps: 60
};
