const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const {
  cameraDevice,
  cameraWidth,
  cameraHeight,
  cameraFps,
  videoAllowedResolutions,
  videoMinFps,
  videoMaxFps,
  sampleRate,
  micChannels,
  speakerChannels,
  pulseSinkName,
  pulseCaptureSourceName,
  talkbackPlaybackGain
} = require('./config');

const state = {
  cameraSettings: {
    width: cameraWidth,
    height: cameraHeight,
    fps: cameraFps
  },
  cameraDevicePreference: cameraDevice,
  activeCameraDevice: null,
  pulseSinkName,
  pulseCaptureSourceName,

  cameraProc: null,
  audioCaptureProc: null,
  audioPlaybackProc: null,

  videoSubscribers: new Set(),
  audioSubscribers: new Set(),

  videoBuffer: Buffer.alloc(0)
};

const maxWsBufferedBytes = 512 * 1024;

const hasCmd = (cmd) => {
  const result = spawnSync('sh', ['-lc', `command -v ${cmd}`], { encoding: 'utf8' });
  return result.status === 0;
};

const runCmd = (cmd) => {
  const result = spawnSync('sh', ['-lc', cmd], { encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || ''
  };
};

const toResolutionObjects = (pairs) => {
  const unique = new Set();
  const out = [];
  for (const [width, height] of pairs) {
    const w = Number.parseInt(width, 10);
    const h = Number.parseInt(height, 10);
    if (!Number.isFinite(w) || !Number.isFinite(h)) continue;
    const key = `${w}x${h}`;
    if (unique.has(key)) continue;
    unique.add(key);
    out.push({ width: w, height: h });
  }
  out.sort((a, b) => (a.width * a.height) - (b.width * b.height));
  return out;
};

const defaultSupportedResolutions = () => toResolutionObjects(videoAllowedResolutions);

const parseV4L2MjpegResolutions = (formatsText) => {
  const lines = String(formatsText || '').split('\n');
  const pairs = [];
  let inMjpegFormat = false;

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/^\s*\[\d+\]:/.test(line)) {
      inMjpegFormat = lower.includes('mjpg') || lower.includes('motion-jpeg');
      continue;
    }
    if (!inMjpegFormat) continue;
    const sizeMatch = line.match(/(\d+)x(\d+)/);
    if (sizeMatch) {
      pairs.push([sizeMatch[1], sizeMatch[2]]);
    }
  }

  return toResolutionObjects(pairs);
};

const parseRpicamPath = (cameraPath) => {
  const match = String(cameraPath || '').trim().match(/^rpicam:\/\/(\d+)$/);
  return match ? match[1] : null;
};

const getCameraSourceType = (cameraPath) => {
  if (parseRpicamPath(cameraPath) !== null) return 'CSI';
  if (String(cameraPath || '').startsWith('/dev/video')) return 'V4L2';
  return 'Unknown';
};

const isSupportedV4L2Camera = (devicePath) => {
  if (!fs.existsSync(devicePath)) return { supported: false, reason: 'device node missing' };
  if (!hasCmd('v4l2-ctl')) return { supported: true, reason: 'v4l2-ctl unavailable; using existing device node' };

  const caps = runCmd(`v4l2-ctl -d ${devicePath} --all`);
  if (!caps.ok) return { supported: false, reason: 'v4l2 query failed' };

  const capsText = caps.stdout.toLowerCase();
  if (capsText.includes('metadata capture') && !capsText.includes('video capture')) {
    return { supported: false, reason: 'metadata-only endpoint' };
  }
  if (!capsText.includes('video capture')) return { supported: false, reason: 'not a video capture endpoint' };

  const formats = runCmd(`v4l2-ctl -d ${devicePath} --list-formats-ext`);
  if (!formats.ok) return { supported: false, reason: 'format enumeration failed' };

  const formatsText = formats.stdout.toLowerCase();
  if (!formatsText.includes('mjpg') && !formatsText.includes('motion-jpeg')) {
    return { supported: false, reason: 'mjpeg not supported' };
  }

  return { supported: true, reason: 'video capture with mjpeg support' };
};

const discoverRpicamCameras = () => {
  if (!hasCmd('rpicam-hello')) return [];
  const result = runCmd('rpicam-hello --list-cameras');
  if (!result.ok) return [];

  const cameras = [];
  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    const match = line.match(/^(\d+)\s*:\s*(.+)$/);
    if (match) {
      cameras.push({ index: match[1], descriptor: match[2], modes: [] });
      continue;
    }
    if (!cameras.length) continue;
    const modeMatch = line.match(/(\d+)x(\d+)\s*\[/);
    if (modeMatch) {
      cameras[cameras.length - 1].modes.push([modeMatch[1], modeMatch[2]]);
    }
  }

  for (const camera of cameras) {
    camera.supportedResolutions = toResolutionObjects(camera.modes);
  }
  return cameras;
};

const getSupportedResolutions = (cameraPath) => {
  if (parseRpicamPath(cameraPath) !== null) {
    const cameraIndex = parseRpicamPath(cameraPath);
    const cameras = discoverRpicamCameras();
    const camera = cameras.find((item) => item.index === cameraIndex);
    if (camera && camera.supportedResolutions && camera.supportedResolutions.length) {
      return camera.supportedResolutions;
    }
    return defaultSupportedResolutions();
  }

  if (String(cameraPath || '').startsWith('/dev/video') && hasCmd('v4l2-ctl')) {
    const formats = runCmd(`v4l2-ctl -d ${cameraPath} --list-formats-ext`);
    if (formats.ok) {
      const resolutions = parseV4L2MjpegResolutions(formats.stdout);
      if (resolutions.length) return resolutions;
    }
  }

  return defaultSupportedResolutions();
};

const isSupportedRpicamCamera = (cameraPath) => {
  const cameraIndex = parseRpicamPath(cameraPath);
  if (cameraIndex === null) return { supported: false, reason: 'invalid rpicam path' };
  if (!hasCmd('rpicam-vid')) return { supported: false, reason: 'rpicam-vid command not found' };

  const cameras = discoverRpicamCameras();
  if (!cameras.length) return { supported: false, reason: 'no CSI cameras reported by rpicam-hello' };

  const available = new Set(cameras.map((camera) => camera.index));
  if (!available.has(cameraIndex)) {
    return { supported: false, reason: `CSI camera index ${cameraIndex} not found` };
  }

  return { supported: true, reason: 'CSI camera via rpicam-vid mjpeg stream' };
};

const listRpicamCameraOptions = () => {
  return discoverRpicamCameras().map((camera) => {
    const path = `rpicam://${camera.index}`;
    const check = isSupportedRpicamCamera(path);
    return {
      path,
      name: `CSI Camera ${camera.index}: ${camera.descriptor}`,
      supported: check.supported,
      reason: check.reason,
      supported_resolutions: (camera.supportedResolutions && camera.supportedResolutions.length)
        ? camera.supportedResolutions
        : defaultSupportedResolutions()
    };
  });
};

const listVideoNodes = () => {
  const entries = fs.readdirSync('/dev', { withFileTypes: true });
  return entries
    .map((entry) => entry.name)
    .filter((name) => /^video\d+$/.test(name))
    .sort((a, b) => Number(a.replace('video', '')) - Number(b.replace('video', '')))
    .map((name) => `/dev/${name}`);
};

const listCameraDeviceOptions = (selectedDevice) => {
  const selected = selectedDevice || state.cameraDevicePreference || state.activeCameraDevice || cameraDevice;
  const seen = new Set();
  const options = [];

  const candidates = [selected, ...listVideoNodes()].filter(Boolean);
  for (const devicePath of candidates) {
    if (seen.has(devicePath)) continue;
    seen.add(devicePath);
    const check = isSupportedV4L2Camera(devicePath);
    if (check.supported) {
      options.push({
        path: devicePath,
        name: devicePath,
        supported: true,
        reason: check.reason,
        supported_resolutions: getSupportedResolutions(devicePath)
      });
    }
  }

  options.push(...listRpicamCameraOptions().filter((item) => item.supported));
  return options;
};

const resolveCameraDevice = (preferredDevice) => {
  const preferred = preferredDevice || cameraDevice;

  if (parseRpicamPath(preferred) !== null) {
    const check = isSupportedRpicamCamera(preferred);
    if (check.supported) return preferred;
  } else if (preferred) {
    const check = isSupportedV4L2Camera(preferred);
    if (check.supported) return preferred;
  }

  for (const devicePath of listVideoNodes()) {
    const check = isSupportedV4L2Camera(devicePath);
    if (check.supported) return devicePath;
  }

  for (const csiCamera of listRpicamCameraOptions()) {
    if (csiCamera.supported) return csiCamera.path;
  }

  return null;
};

const broadcastBinary = (subscribers, payload) => {
  for (const ws of subscribers) {
    if (ws.readyState === ws.OPEN && ws.bufferedAmount <= maxWsBufferedBytes) {
      ws.send(payload, { binary: true }, () => {});
    }
  }
};

const stopProc = (proc) => {
  if (!proc) return;
  try {
    proc.kill('SIGTERM');
  } catch (_) {
    return;
  }
};

const startCamera = () => {
  const width = state.cameraSettings.width;
  const height = state.cameraSettings.height;
  const fps = state.cameraSettings.fps;
  const resolved = resolveCameraDevice(state.cameraDevicePreference || state.activeCameraDevice || cameraDevice);
  if (!resolved) return false;

  stopProc(state.cameraProc);

  const cameraIndex = parseRpicamPath(resolved);
  const args = cameraIndex !== null
    ? [
        'rpicam-vid',
        '--camera', cameraIndex,
        '--codec', 'mjpeg',
        '--width', String(width),
        '--height', String(height),
        '--framerate', String(fps),
        '--timeout', '0',
        '--nopreview',
        '--output', '-'
      ]
    : [
        'ffmpeg', '-loglevel', 'error',
        '-f', 'v4l2',
        '-input_format', 'mjpeg',
        '-video_size', `${width}x${height}`,
        '-framerate', String(fps),
        '-i', resolved,
        '-vcodec', 'copy',
        '-f', 'mjpeg',
        'pipe:1'
      ];

  const proc = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
  state.cameraProc = proc;
  state.activeCameraDevice = resolved;
  state.videoBuffer = Buffer.alloc(0);

  proc.stdout.on('data', (chunk) => {
    state.videoBuffer = Buffer.concat([state.videoBuffer, chunk]);
    let latestJpg = null;
    while (true) {
      const start = state.videoBuffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start === -1) {
        state.videoBuffer = Buffer.alloc(0);
        break;
      }
      const end = state.videoBuffer.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
      if (end === -1) {
        state.videoBuffer = state.videoBuffer.slice(start);
        break;
      }
      const jpg = state.videoBuffer.slice(start, end + 2);
      state.videoBuffer = state.videoBuffer.slice(end + 2);
      latestJpg = jpg;
    }
    if (latestJpg) {
      // Keep stream close to real-time by dropping stale frames and sending only the latest complete JPEG.
      broadcastBinary(state.videoSubscribers, latestJpg);
    }
  });

  proc.on('exit', () => {
    if (state.cameraProc === proc) {
      state.cameraProc = null;
      setTimeout(() => startCamera(), 300);
    }
  });

  return true;
};

const startAudioCapture = () => {
  stopProc(state.audioCaptureProc);
  const proc = spawn('parec', [
    '--device', state.pulseCaptureSourceName,
    '--format=s16le',
    '--rate', String(sampleRate),
    '--channels', String(micChannels),
    '--raw'
  ], { stdio: ['ignore', 'pipe', 'ignore'] });

  state.audioCaptureProc = proc;
  proc.stdout.on('data', (chunk) => {
    broadcastBinary(state.audioSubscribers, chunk);
  });

  proc.on('exit', () => {
    if (state.audioCaptureProc === proc) {
      state.audioCaptureProc = null;
      setTimeout(() => startAudioCapture(), 300);
    }
  });
  return true;
};

const startAudioPlayback = () => {
  stopProc(state.audioPlaybackProc);
  const proc = spawn('pacat', [
    '--playback',
    '--raw',
    '--format=s16le',
    '--rate', String(sampleRate),
    '--channels', String(speakerChannels),
    '--device', state.pulseSinkName,
    '--stream-name', 'surveillance-speaker'
  ], { stdio: ['pipe', 'ignore', 'ignore'] });
  state.audioPlaybackProc = proc;
  proc.on('exit', () => {
    if (state.audioPlaybackProc === proc) {
      state.audioPlaybackProc = null;
    }
  });
  return true;
};

const ensureStarted = () => {
  if (!state.cameraProc) startCamera();
  if (!state.audioCaptureProc) startAudioCapture();
  if (!state.audioPlaybackProc) startAudioPlayback();
};

const normalizeCameraSettings = (width, height, fps, supportedResolutions) => {
  const w = Number.parseInt(width, 10);
  const h = Number.parseInt(height, 10);
  const f = Number.parseInt(fps, 10);
  const supported = (supportedResolutions && supportedResolutions.length)
    ? supportedResolutions
    : defaultSupportedResolutions();
  if (!Number.isFinite(w) || !Number.isFinite(h) || !Number.isFinite(f)) {
    return { error: 'width, height and fps must be integers' };
  }
  if (!supported.some((item) => item.width === w && item.height === h)) {
    const choices = supported.map((item) => `${item.width}x${item.height}`).join(', ');
    return { error: `Unsupported resolution ${w}x${h}. Supported: ${choices}` };
  }
  if (f < videoMinFps || f > videoMaxFps) {
    return { error: `fps must be between ${videoMinFps} and ${videoMaxFps}` };
  }
  return { value: { width: w, height: h, fps: f } };
};

const listCaptureDevices = () => {
  const out = runCmd('pactl list short sources');
  const devices = [{ id: '@DEFAULT_SOURCE@', name: 'Default microphone', kind: 'default' }];
  if (!out.ok) return devices;
  for (const line of out.stdout.split('\n')) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const name = parts[1];
    if (name.endsWith('.monitor')) continue;
    devices.push({ id: name, name, kind: 'pulseaudio-source' });
  }
  return devices;
};

const listOutputSinks = () => {
  const out = runCmd('pactl list short sinks');
  const sinks = [{ id: '@DEFAULT_SINK@', name: 'Default speaker', kind: 'default' }];
  if (!out.ok) return sinks;
  for (const line of out.stdout.split('\n')) {
    const parts = line.split(/\s+/).filter(Boolean);
    if (parts.length < 2) continue;
    const name = parts[1];
    sinks.push({ id: name, name, kind: 'pulseaudio-sink' });
  }
  return sinks;
};

const getSpeakerVolume = () => {
  const sink = state.pulseSinkName || '@DEFAULT_SINK@';
  const out = runCmd(`pactl get-sink-volume ${sink}`);
  if (!out.ok) return null;
  const match = out.stdout.match(/(\d{1,3})%/);
  return match ? Number.parseInt(match[1], 10) : null;
};

const setSpeakerVolume = (volume) => {
  const sink = state.pulseSinkName || '@DEFAULT_SINK@';
  return runCmd(`pactl set-sink-volume ${sink} ${volume}%`).ok;
};

const convertMonoToStereo = (monoBuffer, gain) => {
  const sampleCount = Math.floor(monoBuffer.length / 2);
  const out = Buffer.alloc(sampleCount * 4);
  for (let i = 0; i < sampleCount; i += 1) {
    let sample = monoBuffer.readInt16LE(i * 2);
    sample = Math.max(-32768, Math.min(32767, Math.trunc(sample * gain)));
    out.writeInt16LE(sample, i * 4);
    out.writeInt16LE(sample, i * 4 + 2);
  }
  return out;
};

const writeTalkback = (monoChunk) => {
  if (!state.audioPlaybackProc || !state.audioPlaybackProc.stdin) {
    startAudioPlayback();
  }
  if (!state.audioPlaybackProc || !state.audioPlaybackProc.stdin) return false;

  const stereo = convertMonoToStereo(monoChunk, talkbackPlaybackGain);
  return state.audioPlaybackProc.stdin.write(stereo);
};

const subscribeVideo = (ws) => {
  state.videoSubscribers.add(ws);
};

const unsubscribeVideo = (ws) => {
  state.videoSubscribers.delete(ws);
};

const subscribeAudio = (ws) => {
  state.audioSubscribers.add(ws);
};

const unsubscribeAudio = (ws) => {
  state.audioSubscribers.delete(ws);
};

const getStatus = () => ({
  camera: !!state.cameraProc,
  audio: !!state.audioCaptureProc,
  queue_size: 0,
  camera_device: state.activeCameraDevice || state.cameraDevicePreference || cameraDevice,
  camera_source_type: getCameraSourceType(state.activeCameraDevice || state.cameraDevicePreference || cameraDevice),
  camera_device_preference: state.cameraDevicePreference,
  camera_width: state.cameraSettings.width,
  camera_height: state.cameraSettings.height,
  camera_fps: state.cameraSettings.fps
});

const getCameraSettingsPayload = () => {
  const selected = state.activeCameraDevice || state.cameraDevicePreference || cameraDevice;
  return {
    status: 'ok',
    width: state.cameraSettings.width,
    height: state.cameraSettings.height,
    fps: state.cameraSettings.fps,
    camera_device: state.activeCameraDevice,
    selected_camera_device: selected,
    camera_source_type: getCameraSourceType(selected),
    available_camera_devices: listCameraDeviceOptions(selected),
    supported_resolutions: getSupportedResolutions(selected),
    allowed_resolutions: videoAllowedResolutions.map(([width, height]) => ({ width, height })),
    fps_range: { min: videoMinFps, max: videoMaxFps }
  };
};

const applyCameraSettings = (payload) => {
  const requestedDevice = payload.camera_device
    ? String(payload.camera_device).trim()
    : (state.cameraDevicePreference || state.activeCameraDevice || cameraDevice);
  const supportedResolutions = getSupportedResolutions(requestedDevice);
  const normalized = normalizeCameraSettings(payload.width, payload.height, payload.fps, supportedResolutions);
  if (normalized.error) return { ok: false, code: 400, message: normalized.error };

  if (payload.camera_device) {
    state.cameraDevicePreference = String(payload.camera_device).trim();
  }
  state.cameraSettings = normalized.value;

  if (!startCamera()) {
    return { ok: false, code: 500, message: 'Failed to restart camera process with the requested settings' };
  }
  return { ok: true, payload: getCameraSettingsPayload() };
};

const selectServerAudioDevices = (payload) => {
  const { microphone, speaker } = payload;
  if (microphone) state.pulseCaptureSourceName = microphone;
  if (speaker) state.pulseSinkName = speaker;

  startAudioCapture();
  startAudioPlayback();

  return {
    status: 'ok',
    selected_microphone: state.pulseCaptureSourceName,
    selected_speaker: state.pulseSinkName
  };
};

module.exports = {
  state,
  ensureStarted,
  subscribeVideo,
  unsubscribeVideo,
  subscribeAudio,
  unsubscribeAudio,
  writeTalkback,
  getStatus,
  getCameraSettingsPayload,
  applyCameraSettings,
  listCameraDeviceOptions,
  listCaptureDevices,
  listOutputSinks,
  selectServerAudioDevices,
  getSpeakerVolume,
  setSpeakerVolume
};
