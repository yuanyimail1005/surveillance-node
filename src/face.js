'use strict';

const fs = require('fs');
const path = require('path');
const nodeUrl = require('node:url');
const nodeUtil = require('node:util');
const { EventEmitter } = require('events');

// Lazily loaded — gracefully unavailable if npm packages are missing.
let tf = null;
let faceapi = null;

const DESCRIPTOR_CACHE_VERSION = 2;

/**
 * Load @tensorflow/tfjs-node (CJS) then @vladmandic/face-api (ESM via dynamic import).
 * tfjs-node must be required first so it registers the native backend before face-api loads.
 */
const loadDeps = async () => {
  if (tf && faceapi) return true;
  try {
    // node-pre-gyp (used by tfjs-node) still calls deprecated url.resolve in Node 24+.
    // Use WHATWG URL resolution first and fall back to the original resolver.
    if (!nodeUrl.__surveillanceResolvePatched && typeof nodeUrl.resolve === 'function') {
      const originalResolve = nodeUrl.resolve.bind(nodeUrl);
      nodeUrl.resolve = (from, to) => {
        if (typeof from === 'string' && typeof to === 'string') {
          try {
            return new URL(to, from).toString();
          } catch (_) {
            // Fall through to legacy behavior for non-URL-compatible inputs.
          }
        }
        return originalResolve(from, to);
      };
      nodeUrl.__surveillanceResolvePatched = true;
    }

    // tfjs-node still calls util.isArray internally; point it to Array.isArray to avoid DEP0044.
    if (typeof nodeUtil.isArray !== 'function' || nodeUtil.isArray !== Array.isArray) {
      nodeUtil.isArray = Array.isArray;
    }
    if (typeof nodeUtil.isNullOrUndefined !== 'function') {
      nodeUtil.isNullOrUndefined = (value) => value === null || value === undefined;
    }
    tf = require('@tensorflow/tfjs-node');
    const mod = await import('@vladmandic/face-api');
    faceapi = mod.default || mod;
    return true;
  } catch (err) {
    tf = null;
    faceapi = null;
    console.warn('Face recognition: dependencies not available:', err.message);
    return false;
  }
};

/**
 * FaceRecognitionService — detects and identifies faces in JPEG frames.
 *
 * Wire protocol (matches Python reference):
 *   Emits 'result' with the same JSON shape as get_status(), which server.js forwards
 *   to every video WebSocket subscriber as { type: 'face_data', ...status }.
 *
 * Each face in result.faces: { name, confidence, left, top, right, bottom }
 */
class FaceRecognitionService extends EventEmitter {
  constructor({ enabled, knownFacesDir, detectEveryNFrames, matchThreshold, maxFaces, modelsDir }) {
    super();
    this._enabled = Boolean(enabled);
    this._knownFacesDir = knownFacesDir;
    this._detectEveryNFrames = Math.max(1, detectEveryNFrames);
    this._matchThreshold = matchThreshold;
    this._maxFaces = maxFaces;
    this._modelsDir = modelsDir;

    this._available = false;
    this._initializing = false;
    this._loadPromise = null;
    this._message = 'not initialized';
    this._frameCounter = 0;
    this._processInFlight = false;
    this._knownNames = [];
    this._knownDescriptors = []; // Float32Array[]
    this._faceMatcher = null;
    this._lastResult = {
      updated_at: null,
      frame_index: 0,
      broadcast_frame_seq: 0,
      image_width: 0,
      image_height: 0,
      faces: []
    };
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async init() {
    if (!this._enabled) {
      this._message = 'disabled — use the toggle to enable';
      console.log('Face recognition: disabled by configuration (can be enabled at runtime)');
      return;
    }
    return this._loadModels();
  }

  async _loadModels() {
    if (this._available) return;
    if (this._loadPromise) return this._loadPromise;

    this._initializing = true;
    this._message = 'loading models';
    this._loadPromise = (async () => {
      try {
        if (!(await loadDeps())) {
          this._message = '@tensorflow/tfjs-node or @vladmandic/face-api not installed';
          return;
        }

        console.log('Face recognition: loading models…');
        await faceapi.nets.ssdMobilenetv1.loadFromDisk(this._modelsDir);
        if (!this._enabled) {
          this._message = 'disabled';
          return;
        }
        await faceapi.nets.faceLandmark68Net.loadFromDisk(this._modelsDir);
        if (!this._enabled) {
          this._message = 'disabled';
          return;
        }
        await faceapi.nets.faceRecognitionNet.loadFromDisk(this._modelsDir);
        console.log('Face recognition: models loaded');

        this._message = 'loading known faces';
        await this._loadKnownFaces();

        if (!this._enabled) {
          this._available = false;
          this._message = 'disabled';
          return;
        }

        this._available = true;
        this._message = `ready (${this._knownNames.length} known face${this._knownNames.length !== 1 ? 's' : ''})`;
        console.log(`Face recognition: ${this._message}`);
      } catch (err) {
        this._available = false;
        this._message = `initialization failed: ${err.message}`;
        console.error('Face recognition init error:', err);
      } finally {
        this._initializing = false;
        this._loadPromise = null;
      }
    })();

    return this._loadPromise;
  }

  /**
   * Process one JPEG frame. Throttled by detectEveryNFrames; non-blocking
   * (returns immediately if a detection is already in flight).
   */
  async processFrame(jpegBuffer, frameSeq) {
    if (!this._enabled || !this._available || this._processInFlight) return;
    this._frameCounter += 1;
    if (this._frameCounter % this._detectEveryNFrames !== 0) return;

    this._processInFlight = true;
    let tensor = null;
    try {
      tensor = tf.node.decodeJpeg(jpegBuffer, 3);
      const [height, width] = tensor.shape;

      const options = new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 });
      const detections = await faceapi
        .detectAllFaces(tensor, options)
        .withFaceLandmarks()
        .withFaceDescriptors();

      const limited = this._maxFaces ? detections.slice(0, this._maxFaces) : detections;
      const faces = limited.map((d) => {
        const box = d.detection.box;
        let name = 'Unknown';
        let confidence = 0;

        if (this._faceMatcher) {
          const match = this._faceMatcher.findBestMatch(d.descriptor);
          if (match.label !== 'unknown') {
            name = match.label;
            confidence = Math.max(0, Math.min(1, 1 - match.distance));
          }
        }

        return {
          name,
          confidence: Math.round(confidence * 1000) / 1000,
          left: Math.max(0, Math.round(box.left)),
          top: Math.max(0, Math.round(box.top)),
          right: Math.min(width - 1, Math.round(box.right)),
          bottom: Math.min(height - 1, Math.round(box.bottom))
        };
      });

      this._lastResult = {
        updated_at: Date.now(),
        frame_index: this._frameCounter,
        broadcast_frame_seq: Number(frameSeq) || 0,
        image_width: width,
        image_height: height,
        faces
      };

      this.emit('result', this.getStatus());
    } catch (err) {
      console.error('Face recognition frame error:', err.message);
    } finally {
      if (tensor) tensor.dispose();
      this._processInFlight = false;
    }
  }

  /** Toggle enabled at runtime. Triggers model loading on first enable. */
  setEnabled(enabled) {
    this._enabled = Boolean(enabled);
    if (!this._enabled) {
      this._initializing = false;
      this._lastResult = { updated_at: null, frame_index: 0, broadcast_frame_seq: 0, image_width: 0, image_height: 0, faces: [] };
      this._message = 'disabled';
    } else if (!this._available) {
      // Lazy-load models now that the user has enabled the service.
      this._loadModels().catch((err) => {
        console.error('Face recognition lazy-init error:', err);
      });
    }
  }

  /** Returns a status object matching the Python reference wire format (snake_case). */
  getStatus() {
    return {
      enabled: this._enabled,
      available: this._available,
      initializing: this._initializing,
      backend: 'face-api.js',
      message: this._message,
      known_faces_count: this._knownNames.length,
      detect_every_n_frames: this._detectEveryNFrames,
      match_threshold: this._matchThreshold,
      max_faces: this._maxFaces,
      result: { ...this._lastResult, faces: [...this._lastResult.faces] }
    };
  }

  shutdown() {
    this.removeAllListeners();
    this._available = false;
  }

  // ---------------------------------------------------------------------------
  // Known-face loading & descriptor caching
  // ---------------------------------------------------------------------------

  async _loadKnownFaces() {
    const dir = this._knownFacesDir;
    if (!fs.existsSync(dir)) {
      console.warn(`Face recognition: known_faces dir not found: ${dir} — all detections will be labelled Unknown`);
      return;
    }

    const cacheFile = path.join(dir, '.face_descriptor_cache.json');
    const imagePairs = this._collectImagePairs(dir);
    const currentKeys = imagePairs.map(([, p]) => this._imageFileKey(p));

    // Try reading from cache.
    try {
      const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
      const hasCachedDescriptors = Array.isArray(raw.names) && raw.names.length > 0;
      const shouldReuseEmptyCache = currentKeys.length === 0;
      if (
        raw.version === DESCRIPTOR_CACHE_VERSION &&
        JSON.stringify(raw.keys) === JSON.stringify(currentKeys) &&
        (hasCachedDescriptors || shouldReuseEmptyCache)
      ) {
        this._knownNames = raw.names;
        this._knownDescriptors = raw.descriptors.map((d) => new Float32Array(d));
        this._buildFaceMatcher();
        console.log(`Face recognition: loaded ${this._knownNames.length} descriptor(s) from cache`);
        return;
      }
    } catch (_) {}

    // Compute descriptors from images.
    console.log(`Face recognition: computing descriptors for ${imagePairs.length} image(s)…`);
    const names = [];
    const descriptors = [];

    for (const [personName, imgPath] of imagePairs) {
      let tensor = null;
      try {
        const buf = fs.readFileSync(imgPath);
        tensor = tf.node.decodeImage(buf, 3);
        const detection = await faceapi
          .detectSingleFace(tensor)
          .withFaceLandmarks()
          .withFaceDescriptor();

        if (!detection) {
          console.warn(`  Face recognition: no face in ${imgPath}`);
          continue;
        }
        names.push(personName);
        descriptors.push(Array.from(detection.descriptor));
        console.log(`  Encoded: ${personName} (${path.basename(imgPath)})`);
      } catch (err) {
        console.warn(`  Face recognition: error on ${imgPath}: ${err.message}`);
      } finally {
        if (tensor) tensor.dispose();
      }
    }

    this._knownNames = names;
    this._knownDescriptors = descriptors.map((d) => new Float32Array(d));
    this._buildFaceMatcher();

    // Persist cache.
    try {
      fs.writeFileSync(cacheFile, JSON.stringify({
        version: DESCRIPTOR_CACHE_VERSION,
        keys: currentKeys,
        names,
        descriptors
      }), 'utf8');
    } catch (err) {
      console.warn('Face recognition: failed to write descriptor cache:', err.message);
    }
    console.log(`Face recognition: ${names.length} descriptor(s) computed and cached`);
  }

  _buildFaceMatcher() {
    if (!faceapi || !this._knownNames.length) {
      this._faceMatcher = null;
      return;
    }
    const byName = new Map();
    for (let i = 0; i < this._knownNames.length; i++) {
      const n = this._knownNames[i];
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(this._knownDescriptors[i]);
    }
    const labeled = Array.from(byName.entries()).map(
      ([n, descs]) => new faceapi.LabeledFaceDescriptors(n, descs)
    );
    this._faceMatcher = new faceapi.FaceMatcher(labeled, this._matchThreshold);
  }

  /** Collect (personName, imagePath) pairs sorted by person name then filename. */
  _collectImagePairs(dir) {
    const pairs = [];
    let entries;
    try { entries = fs.readdirSync(dir); } catch (_) { return pairs; }

    for (const personName of entries.sort()) {
      const personDir = path.join(dir, personName);
      try { if (!fs.statSync(personDir).isDirectory()) continue; } catch (_) { continue; }
      let images;
      try {
        images = fs.readdirSync(personDir)
          .filter((f) => /\.(jpe?g|png)$/i.test(f))
          .sort();
      } catch (_) { continue; }

      for (const img of images) {
        pairs.push([personName, path.join(personDir, img)]);
      }
    }
    return pairs;
  }

  /** Returns a stable key for cache invalidation: [relative path, mtime ms, size]. */
  _imageFileKey(imgPath) {
    try {
      const st = fs.statSync(imgPath);
      return [path.relative(this._knownFacesDir, imgPath), st.mtimeMs, st.size];
    } catch (_) {
      return [imgPath, 0, 0];
    }
  }
}

module.exports = { FaceRecognitionService };
