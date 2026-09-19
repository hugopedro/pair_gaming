/**
 * js/emulator.js - Core NES Emulation Engine for Duplinha NES
 * Built on top of JSNES with 60 FPS WebGL/Canvas2D rendering,
 * circular-buffer Web Audio synthesis and WebRTC MediaStream broadcasting.
 */

class NesEmulator {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    // Active aspect ratio mode: 'superwide' | '4-3' | '16-10' | '16-9' | 'original'
    this.aspectRatioMode = localStorage.getItem('duplinha_ratio') || 'superwide';
    this.cropOverscan = localStorage.getItem('duplinha_crop_overscan') !== 'false';

    // xBRZ 6x High-Performance Scaler via WebAssembly (256x240 -> 1536x1440)
    this.scaler = new XbrzScaler(256, 240, 6);

    // Intermediate 1536x1440 canvas for xBRZ
    this.xbrzCanvas = document.createElement('canvas');
    this.xbrzCanvas.width = 1536;
    this.xbrzCanvas.height = 1440;
    this.xbrzCtx = this.xbrzCanvas.getContext('2d', { alpha: false });
    this.xbrzImageData = this.xbrzCtx.createImageData(1536, 1440);

    // Raw 256x240 canvas for crisp Pixel Art mode (zero xBRZ overhead/flicker)
    this.rawCanvas = document.createElement('canvas');
    this.rawCanvas.width = 256;
    this.rawCanvas.height = 240;
    this.rawCtx = this.rawCanvas.getContext('2d', { alpha: false });
    this.rawImageData = this.rawCtx.createImageData(256, 240);

    // Video Filter: 'xbrz' | 'crisp'
    this.videoFilter = localStorage.getItem('duplinha_filter') || 'xbrz';

    // Raw 256x240 buffer for JSNES
    this.buf = new ArrayBuffer(256 * 240 * 4);
    this.buf8 = new Uint8ClampedArray(this.buf);
    this.buf32 = new Uint32Array(this.buf);
    for (let i = 0; i < this.buf32.length; i++) {
      this.buf32[i] = 0xFF000000; // Black opaque
    }

    // Precompute SuperWide non-linear stretch strip table
    this._initSuperWideTable();

    // Set canvas dimensions according to aspect ratio
    this._updateCanvasSize();

    // Audio Pipeline
    this.audioCtx = null;
    this.audioGain = null;
    this.mediaStreamDest = null;
    this.audioNode = null;
    this.audioBufferSize = 16384;
    this.audioBufferL = new Float32Array(this.audioBufferSize);
    this.audioBufferR = new Float32Array(this.audioBufferSize);
    this.audioWritePos = 0;
    this.audioReadPos = 0;
    this.audioCount = 0;
    this.volume = 0.8;
    this.isMuted = false;

    // Emulator State
    this.nes = null;
    this.currentRomData = null;
    this.currentRomName = '';
    this.isRunning = false;
    this.isPaused = false;
    this.animationFrameId = null;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.frameCount = 0;
    this.fpsTimer = performance.now();

    // Rewind Ring Buffer (stores snapshots every 30 frames = 0.5s for up to 15s)
    this.rewindBuffer = [];
    this.maxRewindStates = 30; // 30 states * 0.5s = 15 seconds
    this.rewindIntervalFrames = 30;
    this.isRewinding = false;

    // Callbacks
    this.onStatusChange = null;
    this.onFPSUpdate = null;

    this._initNES();
  }

  _updateCanvasSize() {
    const widthMap = {
      'superwide': 1280,
      '16-9': 1280,
      '16-10': 1152,
      '4-3': 960,
      'original': 768
    };
    const targetW = widthMap[this.aspectRatioMode] || 1280;
    const targetH = 720;
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
    this._initSuperWideTable();
  }

  setAspectRatio(ratio) {
    this.aspectRatioMode = ratio;
    this._updateCanvasSize();
  }

  toggleCropOverscan() {
    this.cropOverscan = !this.cropOverscan;
    localStorage.setItem('duplinha_crop_overscan', this.cropOverscan ? 'true' : 'false');
    this._initSuperWideTable();
    return this.cropOverscan;
  }

  _initSuperWideTable() {
    const N = 32;
    const srcX0 = this.cropOverscan ? 48 : 0;
    const srcY0 = this.cropOverscan ? 48 : 0;
    const srcW = this.cropOverscan ? 1440 : 1536;
    const srcH = this.cropOverscan ? 1344 : 1440;
    const dstW = this.canvas.width;
    const a = 0.75; // 0.75 preserves exact 4:3 scale at center
    this.superWideTable = [];

    for (let i = 0; i < N; i++) {
      const u0 = i / N;
      const u1 = (i + 1) / N;
      const s0 = 2 * u0 - 1;
      const s1 = 2 * u1 - 1;

      const d0 = (a * s0 + (1 - a) * Math.pow(s0, 3) + 1) / 2;
      const d1 = (a * s1 + (1 - a) * Math.pow(s1, 3) + 1) / 2;

      const sx = srcX0 + i * (srcW / N);
      const sw = srcW / N;
      const dx = d0 * dstW;
      const dw = (d1 * dstW) - dx + 0.6; // Overlap to prevent seams

      this.superWideTable.push({ sx, sy: srcY0, sw, sh: srcH, dx, dw });
    }
  }

  _drawSuperWide() {
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    const table = this.superWideTable;
    const len = table.length;
    const h = this.canvas.height;
    for (let i = 0; i < len; i++) {
      const s = table[i];
      this.ctx.drawImage(this.xbrzCanvas, s.sx, s.sy, s.sw, s.sh, s.dx, 0, s.dw, h);
    }
  }

  _initNES() {
    this.nes = new jsnes.NES({
      onFrame: (frameBuffer) => {
        // Copy 256x240 frame from JSNES
        for (let i = 0; i < 61440; i++) {
          this.buf32[i] = 0xFF000000 | frameBuffer[i];
        }

        if (this.videoFilter === 'crisp') {
          // Pixel Art mode: 100% crisp retro pixels, zero xBRZ morphing / zero flickering
          this.rawImageData.data.set(this.buf8);
          this.rawCtx.putImageData(this.rawImageData, 0, 0);

          this.ctx.imageSmoothingEnabled = false;
          const sx = this.cropOverscan ? 8 : 0;
          const sy = this.cropOverscan ? 8 : 0;
          const sw = this.cropOverscan ? 240 : 256;
          const sh = this.cropOverscan ? 224 : 240;
          this.ctx.drawImage(this.rawCanvas, sx, sy, sw, sh, 0, 0, this.canvas.width, this.canvas.height);
        } else {
          // 1. Scale with xBRZ 6x (256x240 -> 1536x1440) via WebAssembly
          const scaled = this.scaler.scale(this.buf8);
          this.xbrzImageData.data.set(scaled);
          this.xbrzCtx.putImageData(this.xbrzImageData, 0, 0);

          // 2. Render to final canvas (SuperWide non-linear or standard aspect ratio)
          if (this.aspectRatioMode === 'superwide') {
            this._drawSuperWide();
          } else {
            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'high';
            const sx = this.cropOverscan ? 48 : 0;
            const sy = this.cropOverscan ? 48 : 0;
            const sw = this.cropOverscan ? 1440 : 1536;
            const sh = this.cropOverscan ? 1344 : 1440;
            this.ctx.drawImage(this.xbrzCanvas, sx, sy, sw, sh, 0, 0, this.canvas.width, this.canvas.height);
          }
        }
      },
      onAudioSample: (left, right) => {
        // Feed sample into circular ring buffer
        if (this.audioCount < this.audioBufferSize) {
          this.audioBufferL[this.audioWritePos] = left;
          this.audioBufferR[this.audioWritePos] = right;
          this.audioWritePos = (this.audioWritePos + 1) % this.audioBufferSize;
          this.audioCount++;
        }
      },
      sampleRate: 44100
    });
  }

  _initAudioContext() {
    if (this.audioCtx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    this.audioCtx = new AudioContextClass({ sampleRate: 44100 });

    // Gain node for volume control
    this.audioGain = this.audioCtx.createGain();
    this.audioGain.gain.value = this.isMuted ? 0 : this.volume;

    // MediaStream destination for WebRTC P2P audio broadcasting
    this.mediaStreamDest = this.audioCtx.createMediaStreamDestination();

    // ScriptProcessorNode for buffer playback
    this.audioNode = this.audioCtx.createScriptProcessor(2048, 0, 2);
    this.audioNode.onaudioprocess = (e) => {
      const outL = e.outputBuffer.getChannelData(0);
      const outR = e.outputBuffer.getChannelData(1);
      const len = outL.length;

      for (let i = 0; i < len; i++) {
        if (this.audioCount > 0) {
          outL[i] = this.audioBufferL[this.audioReadPos];
          outR[i] = this.audioBufferR[this.audioReadPos];
          this.audioReadPos = (this.audioReadPos + 1) % this.audioBufferSize;
          this.audioCount--;
        } else {
          outL[i] = 0;
          outR[i] = 0;
        }
      }
    };

    // Connect node to both local speakers and WebRTC stream
    this.audioNode.connect(this.audioGain);
    this.audioGain.connect(this.audioCtx.destination);
    this.audioGain.connect(this.mediaStreamDest);
  }

  loadROM(binaryString, romName = 'Jogo NES') {
    this._initAudioContext();
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    try {
      this.currentRomData = binaryString;
      this.currentRomName = romName;
      this.rewindBuffer = [];
      this.nes.loadROM(binaryString);
      this.start();
      if (this.onStatusChange) this.onStatusChange(`ROM Carregada: ${romName}`);
      return true;
    } catch (err) {
      console.error('Erro ao carregar ROM no JSNES:', err);
      if (this.onStatusChange) this.onStatusChange(`Erro: ${err.message}`);
      return false;
    }
  }

  reloadROM() {
    if (this.currentRomData) {
      this.rewindBuffer = [];
      this.loadROM(this.currentRomData, this.currentRomName);
    }
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this.lastFrameTime = performance.now();
    this.fpsTimer = performance.now();
    this.frameCount = 0;
    this._loop();
  }

  stop() {
    this.isRunning = false;
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  togglePause() {
    if (!this.isRunning) return false;
    this.isPaused = !this.isPaused;
    if (!this.isPaused) {
      this.lastFrameTime = performance.now();
      this._loop();
    }
    return this.isPaused;
  }

  setVideoFilter(filter) {
    this.videoFilter = filter;
    localStorage.setItem('duplinha_filter', filter);
  }

  toggleVideoFilter() {
    this.videoFilter = this.videoFilter === 'xbrz' ? 'crisp' : 'xbrz';
    localStorage.setItem('duplinha_filter', this.videoFilter);
    return this.videoFilter;
  }

  _captureRewindState() {
    if (!this.nes || !this.isRunning || this.isPaused || this.isRewinding) return;
    try {
      const state = this.nes.toJSON();
      this.rewindBuffer.push(state);
      if (this.rewindBuffer.length > this.maxRewindStates) {
        this.rewindBuffer.shift();
      }
    } catch (err) {
      // Ignore if state capture fails
    }
  }

  rewind(seconds = 3) {
    if (!this.nes || this.rewindBuffer.length === 0) return false;
    const stepsToPop = Math.max(1, Math.round(seconds * 2));
    for (let i = 0; i < stepsToPop; i++) {
      if (this.rewindBuffer.length > 1) {
        this.rewindBuffer.pop();
      }
    }
    const targetState = this.rewindBuffer[this.rewindBuffer.length - 1];
    if (targetState) {
      this.isRewinding = true;
      try {
        this.nes.fromJSON(targetState);
        this.isRewinding = false;
        return true;
      } catch (err) {
        console.error('Erro no rewind:', err);
        this.isRewinding = false;
        return false;
      }
    }
    return false;
  }

  _loop() {
    if (!this.isRunning || this.isPaused) return;

    const now = performance.now();
    const elapsed = now - this.lastFrameTime;

    // Target 60 FPS (~16.66ms per frame)
    // 12.5ms threshold prevents dropping frames on 60Hz displays due to scheduler jitter
    if (elapsed >= 12.5) {
      try {
        this.nes.frame();
        this.frameCount++;

        // Capture rewind snapshot every 30 frames (0.5s)
        if (this.frameCount % this.rewindIntervalFrames === 0) {
          this._captureRewindState();
        }
      } catch (err) {
        console.error('Erro na execução do frame NES:', err);
      }
      this.lastFrameTime = now - (elapsed % 16.666);

      // Update FPS counter every 1 second
      if (now - this.fpsTimer >= 1000) {
        this.fps = this.frameCount;
        this.frameCount = 0;
        this.fpsTimer = now;
        if (this.onFPSUpdate) this.onFPSUpdate(this.fps);
      }
    }

    this.animationFrameId = requestAnimationFrame(() => this._loop());
  }

  buttonDown(player, buttonName) {
    if (!this.nes) return;
    const btnCode = jsnes.Controller[buttonName];
    if (btnCode !== undefined) {
      this.nes.buttonDown(player, btnCode);
    }
  }

  buttonUp(player, buttonName) {
    if (!this.nes) return;
    const btnCode = jsnes.Controller[buttonName];
    if (btnCode !== undefined) {
      this.nes.buttonUp(player, btnCode);
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.audioGain && !this.isMuted) {
      this.audioGain.gain.value = this.volume;
    }
  }

  toggleMute() {
    this.isMuted = !this.isMuted;
    if (this.audioGain) {
      this.audioGain.gain.value = this.isMuted ? 0 : this.volume;
    }
    return this.isMuted;
  }

  // IndexedDB Persistent Storage Helper for Large Save States (>1MB)
  _openDB() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        return reject(new Error('IndexedDB não suportado'));
      }
      const req = indexedDB.open('duplinha_nes_db', 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('save_states')) {
          req.result.createObjectStore('save_states');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this._dbPromise;
  }

  async _dbSet(key, val) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('save_states', 'readwrite');
        tx.objectStore('save_states').put(val, key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      });
    } catch (e) {
      console.warn('IndexedDB set falhou:', e);
      return false;
    }
  }

  async _dbGet(key) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('save_states', 'readonly');
        const req = tx.objectStore('save_states').get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB get falhou:', e);
      return null;
    }
  }

  async saveState() {
    if (!this.nes) return null;
    try {
      const state = this.nes.toJSON();
      // 1. Instant in-memory save (always reliable and zero-latency)
      this.memorySaveState = state;

      // 2. Persist to IndexedDB (bypasses localStorage 5MB quota)
      if (this.currentRomName) {
        await this._dbSet(`duplinha_save_${this.currentRomName}`, state);
      }
      return state;
    } catch (e) {
      console.error('Falha ao salvar estado:', e);
      if (this.memorySaveState) return this.memorySaveState;
      return null;
    }
  }

  async loadState(savedState = null) {
    if (!this.nes) return false;
    try {
      let state = savedState;

      // 1. In-memory state
      if (!state && this.memorySaveState) {
        state = this.memorySaveState;
      }

      // 2. IndexedDB state
      if (!state && this.currentRomName) {
        state = await this._dbGet(`duplinha_save_${this.currentRomName}`);
      }

      // 3. Fallback to localStorage (legacy)
      if (!state && this.currentRomName) {
        try {
          const stored = localStorage.getItem(`duplinha_save_${this.currentRomName}`);
          if (stored) state = JSON.parse(stored);
        } catch (_) {}
      }

      if (state) {
        this.nes.fromJSON(state);
        this.memorySaveState = state;
        return true;
      }
      return false;
    } catch (e) {
      console.error('Falha ao carregar estado:', e);
      return false;
    }
  }

  /**
   * Captures the live 60 FPS video track + Web Audio track
   * for peer-to-peer streaming via WebRTC
   */
  getMediaStream() {
    this._initAudioContext();
    const videoStream = this.canvas.captureStream ? this.canvas.captureStream(60) : null;
    if (!videoStream) return null;

    const videoTrack = videoStream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      // Prioritize high detail/sharpness over motion blur for pixel art & HUD
      videoTrack.contentHint = 'detail';
    }

    const audioTrack = (this.mediaStreamDest && this.mediaStreamDest.stream) 
      ? this.mediaStreamDest.stream.getAudioTracks()[0] 
      : null;

    const tracks = [];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);

    return new MediaStream(tracks);
  }
}
