const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const wsBase = `${proto}://${location.host}`;

const videoImg = document.getElementById('video');
const cameraDevice = document.getElementById('cameraDevice');
const resolutionSelect = document.getElementById('resolution');
const fpsInput = document.getElementById('fps');
const microphoneSelect = document.getElementById('microphone');
const speakerSelect = document.getElementById('speaker');
const volumeInput = document.getElementById('volume');

let audioCtx;
let audioSocket;
let talkSocket;
let mediaRecorder;
const cameraResolutionsByDevice = new Map();
let latestVideoData = null;
let videoRenderScheduled = false;
let currentVideoObjectUrl = null;

const scheduleVideoRender = () => {
  if (videoRenderScheduled) return;
  videoRenderScheduled = true;
  requestAnimationFrame(() => {
    videoRenderScheduled = false;
    if (!latestVideoData) return;

    const frame = latestVideoData;
    latestVideoData = null;

    const blob = new Blob([frame], { type: 'image/jpeg' });
    const nextUrl = URL.createObjectURL(blob);
    const previousUrl = currentVideoObjectUrl;

    videoImg.onload = () => {
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    };
    videoImg.src = nextUrl;
    currentVideoObjectUrl = nextUrl;

    if (latestVideoData) scheduleVideoRender();
  });
};

const fetchJson = async (url, opts) => {
  const res = await fetch(url, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
};

const startVideo = () => {
  const ws = new WebSocket(`${wsBase}/video_feed`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (event) => {
    latestVideoData = event.data;
    scheduleVideoRender();
  };
  ws.onclose = () => {
    if (currentVideoObjectUrl) {
      URL.revokeObjectURL(currentVideoObjectUrl);
      currentVideoObjectUrl = null;
    }
  };
};

const startAudio = () => {
  audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
  audioSocket = new WebSocket(`${wsBase}/audio_feed`);
  audioSocket.binaryType = 'arraybuffer';
  audioSocket.onmessage = async (event) => {
    const data = new Int16Array(event.data);
    const buffer = audioCtx.createBuffer(1, data.length, 48000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) channel[i] = data[i] / 32768;
    const source = audioCtx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioCtx.destination);
    source.start();
  };
};

const fillResolutionOptions = (resolutions, selectedWidth, selectedHeight) => {
  resolutionSelect.innerHTML = '';
  if (!Array.isArray(resolutions) || !resolutions.length) return;

  for (const item of resolutions) {
    const option = document.createElement('option');
    option.value = `${item.width}x${item.height}`;
    option.textContent = `${item.width}x${item.height}`;
    if (item.width === selectedWidth && item.height === selectedHeight) option.selected = true;
    resolutionSelect.appendChild(option);
  }

  if (resolutionSelect.selectedIndex === -1) {
    resolutionSelect.selectedIndex = 0;
  }
};

const updateResolutionForSelectedCamera = (selectedWidth, selectedHeight, fallbackResolutions) => {
  const resolutions = cameraResolutionsByDevice.get(cameraDevice.value)
    || fallbackResolutions
    || [];
  fillResolutionOptions(resolutions, selectedWidth, selectedHeight);
};

const loadCameraSettings = async () => {
  const data = await fetchJson('/camera_settings');
  cameraResolutionsByDevice.clear();
  cameraDevice.innerHTML = '';
  for (const item of data.available_camera_devices) {
    const option = document.createElement('option');
    option.value = item.path;
    option.textContent = item.name;
    if (item.path === data.selected_camera_device) option.selected = true;
    cameraDevice.appendChild(option);
    cameraResolutionsByDevice.set(item.path, item.supported_resolutions || []);
  }
  updateResolutionForSelectedCamera(data.width, data.height, data.supported_resolutions || data.allowed_resolutions || []);
  fpsInput.value = data.fps;
};

const loadAudioDevices = async () => {
  const data = await fetchJson('/server_audio_devices');
  microphoneSelect.innerHTML = '';
  data.microphones.forEach((mic) => {
    const option = document.createElement('option');
    option.value = mic.id;
    option.textContent = mic.name;
    if (mic.id === data.selected_microphone) option.selected = true;
    microphoneSelect.appendChild(option);
  });

  speakerSelect.innerHTML = '';
  data.speakers.forEach((spk) => {
    const option = document.createElement('option');
    option.value = spk.id;
    option.textContent = spk.name;
    if (spk.id === data.selected_speaker) option.selected = true;
    speakerSelect.appendChild(option);
  });
};

const loadVolume = async () => {
  const data = await fetchJson('/speaker_volume');
  volumeInput.value = data.volume;
};

document.getElementById('saveCamera').onclick = async () => {
  const [width, height] = String(resolutionSelect.value || '').split('x').map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return;
  await fetchJson('/camera_settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      camera_device: cameraDevice.value,
      width,
      height,
      fps: Number(fpsInput.value)
    })
  });
};

cameraDevice.onchange = () => {
  updateResolutionForSelectedCamera();
};

document.getElementById('saveAudioDevices').onclick = async () => {
  await fetchJson('/server_audio_devices/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      microphone: microphoneSelect.value,
      speaker: speakerSelect.value
    })
  });
};

document.getElementById('saveVolume').onclick = async () => {
  await fetchJson('/speaker_volume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ volume: Number(volumeInput.value) })
  });
};

let isTalking = false;

const startTalk = async () => {
  talkSocket = new WebSocket(`${wsBase}/ws/talk`);
  talkSocket.binaryType = 'arraybuffer';

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

  mediaRecorder.ondataavailable = async (e) => {
    if (!e.data || !e.data.size || talkSocket.readyState !== WebSocket.OPEN) return;
    const buf = await e.data.arrayBuffer();
    talkSocket.send(buf);
  };
  mediaRecorder.start(100);
  isTalking = true;
  document.getElementById('talkToggle').textContent = 'Stop Talk';
};

const stopTalk = () => {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (talkSocket && talkSocket.readyState === WebSocket.OPEN) talkSocket.close();
  isTalking = false;
  document.getElementById('talkToggle').textContent = 'Hold to Talk';
};

document.getElementById('talkToggle').onclick = async () => {
  if (isTalking) {
    stopTalk();
  } else {
    await startTalk();
  }
};

(async () => {
  startVideo();
  startAudio();
  await loadCameraSettings();
  await loadAudioDevices();
  await loadVolume();
})();
