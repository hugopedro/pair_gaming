/**
 * js/emulator.js - Core NES Emulation Engine for Duplinha NES
 * Built on top of JSNES with 60 FPS WebGL/Canvas2D rendering,
 * circular-buffer Web Audio synthesis and WebRTC MediaStream broadcasting.
 */

class NesEmulator {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    // Active graphic filter mode: 'smooth' | 'scale2x' | 'pixelated'
    this.filterMode = localStorage.getItem('duplinha_filter') || 'smooth';

    // Active aspect ratio mode: 'superwide' | '4-3' | '16-10' | '16-9' | 'original'
    this.aspectRatioMode = localStorage.getItem('duplinha_ratio') || 'superwide';

    // Internal 256x240 buffer for JSNES
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCanvas.width = 256;
    this.offscreenCanvas.height = 240;
    this.offscreenCtx = this.offscreenCanvas.getContext('2d', { alpha: false });
    this.offscreenImageData = this.offscreenCtx.createImageData(256, 240);

    this.buf = new ArrayBuffer(this.offscreenImageData.data.length);
    this.buf8 = new Uint8ClampedArray(this.buf);
    this.buf32 = new Uint32Array(this.buf);
    for (let i = 0; i < this.buf32.length; i++) {
      this.buf32[i] = 0xFF000000; // Black opaque
    }

    // Intermediate 512x480 canvas for filtering
    this.scaleCanvas = document.createElement('canvas');
    this.scaleCanvas.width = 512;
    this.scaleCanvas.height = 480;
    this.scaleCtx = this.scaleCanvas.getContext('2d', { alpha: false });

    // 512x480 Buffer for Scale2x filter
    this.scaleImageData = this.scaleCtx.createImageData(512, 480);
    this.scaleBuf = new ArrayBuffer(this.scaleImageData.data.length);
    this.scaleBuf8 = new Uint8ClampedArray(this.scaleBuf);
    this.scaleBuf32 = new Uint32Array(this.scaleBuf);
    for (let i = 0; i < this.scaleBuf32.length; i++) {
      this.scaleBuf32[i] = 0xFF000000;
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

    // Callbacks
    this.onStatusChange = null;
    this.onFPSUpdate = null;

    this._initNES();
  }

  _updateCanvasSize() {
    const widthMap = {
      'superwide': 854,
      '16-9': 854,
      '16-10': 768,
      '4-3': 640,
      'original': 512
    };
    const targetW = widthMap[this.aspectRatioMode] || 854;
    if (this.canvas.width !== targetW || this.canvas.height !== 480) {
      this.canvas.width = targetW;
      this.canvas.height = 480;
    }
  }

  setAspectRatio(ratio) {
    this.aspectRatioMode = ratio;
    this._updateCanvasSize();
  }

  _initSuperWideTable() {
    const N = 32;
    const srcW = 512;
    const dstW = 854;
    const a = 0.75; // 0.75 preserves exact 4:3 scale at center
    this.superWideTable = [];

    for (let i = 0; i < N; i++) {
      const u0 = i / N;
      const u1 = (i + 1) / N;
      const s0 = 2 * u0 - 1;
      const s1 = 2 * u1 - 1;

      const d0 = (a * s0 + (1 - a) * Math.pow(s0, 3) + 1) / 2;
      const d1 = (a * s1 + (1 - a) * Math.pow(s1, 3) + 1) / 2;

      const sx = i * (srcW / N);
      const sw = srcW / N;
      const dx = d0 * dstW;
      const dw = (d1 * dstW) - dx + 0.6; // Overlap to prevent seams

      this.superWideTable.push({ sx, sw, dx, dw });
    }
  }

  _drawSuperWide() {
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    const table = this.superWideTable;
    const len = table.length;
    for (let i = 0; i < len; i++) {
      const s = table[i];
      this.ctx.drawImage(this.scaleCanvas, s.sx, 0, s.sw, 480, s.dx, 0, s.dw, 480);
    }
  }

  _initNES() {
    this.nes = new jsnes.NES({
      onFrame: (frameBuffer) => {
        // Copy 256x240 frame from JSNES
        for (let i = 0; i < 61440; i++) {
          this.buf32[i] = 0xFF000000 | frameBuffer[i];
        }

        // 1. Render to intermediate 512x480 scaleCanvas
        if (this.filterMode === 'scale2x') {
          this._applyScale2x(this.buf32, this.scaleBuf32, 256, 240);
          this.scaleImageData.data.set(this.scaleBuf8);
          this.scaleCtx.putImageData(this.scaleImageData, 0, 0);
        } else {
          this.offscreenImageData.data.set(this.buf8);
          this.offscreenCtx.putImageData(this.offscreenImageData, 0, 0);

          this.scaleCtx.imageSmoothingEnabled = (this.filterMode === 'smooth');
          this.scaleCtx.imageSmoothingQuality = 'high';
          this.scaleCtx.drawImage(this.offscreenCanvas, 0, 0, 512, 480);
        }

        // 2. Render to final canvas (SuperWide non-linear or standard aspect ratio)
        if (this.aspectRatioMode === 'superwide') {
          this._drawSuperWide();
        } else {
          this.ctx.imageSmoothingEnabled = (this.filterMode === 'smooth');
          this.ctx.imageSmoothingQuality = 'high';
          this.ctx.drawImage(this.scaleCanvas, 0, 0, this.canvas.width, this.canvas.height);
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

  setFilter(mode) {
    if (!['smooth', 'scale2x', 'pixelated'].includes(mode)) mode = 'smooth';
    this.filterMode = mode;
    localStorage.setItem('duplinha_filter', mode);
    return mode;
  }

  _applyScale2x(src, dst, width, height) {
    const dstWidth = width << 1;
    for (let y = 0; y < height; y++) {
      const yPrev = (y > 0 ? y - 1 : 0) * width;
      const yCurr = y * width;
      const yNext = (y < height - 1 ? y + 1 : height - 1) * width;
      const dstY0 = (y << 1) * dstWidth;
      const dstY1 = ((y << 1) + 1) * dstWidth;

      for (let x = 0; x < width; x++) {
        const xPrev = x > 0 ? x - 1 : 0;
        const xNext = x < width - 1 ? x + 1 : width - 1;

        const P = src[yCurr + x];
        const A = src[yPrev + x];
        const C = src[yCurr + xPrev];
        const B = src[yCurr + xNext];
        const D = src[yNext + x];

        let E0 = P, E1 = P, E2 = P, E3 = P;

        if (C === A && C !== D && A !== B) E0 = A;
        if (A === B && A !== C && B !== D) E1 = B;
        if (D === C && D !== B && C !== A) E2 = C;
        if (B === D && B !== A && D !== C) E3 = D;

        const dstX = x << 1;
        dst[dstY0 + dstX] = E0;
        dst[dstY0 + dstX + 1] = E1;
        dst[dstY1 + dstX] = E2;
        dst[dstY1 + dstX + 1] = E3;
      }
    }
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

  _loop() {
    if (!this.isRunning || this.isPaused) return;

    const now = performance.now();
    const elapsed = now - this.lastFrameTime;

    // Target 60 FPS (~16.6ms per frame)
    if (elapsed >= 15.5) {
      try {
        this.nes.frame();
        this.frameCount++;
      } catch (err) {
        console.error('Erro na execução do frame NES:', err);
      }
      this.lastFrameTime = now;

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

  saveState() {
    if (!this.nes) return null;
    try {
      const state = this.nes.toJSON();
      const stateStr = JSON.stringify(state);
      if (this.currentRomName) {
        localStorage.setItem(`duplinha_save_${this.currentRomName}`, stateStr);
      }
      return state;
    } catch (e) {
      console.error('Falha ao salvar estado:', e);
      return null;
    }
  }

  loadState(savedState = null) {
    if (!this.nes) return false;
    try {
      let state = savedState;
      if (!state && this.currentRomName) {
        const stored = localStorage.getItem(`duplinha_save_${this.currentRomName}`);
        if (stored) state = JSON.parse(stored);
      }
      if (state) {
        this.nes.fromJSON(state);
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
    const audioTrack = (this.mediaStreamDest && this.mediaStreamDest.stream) 
      ? this.mediaStreamDest.stream.getAudioTracks()[0] 
      : null;

    const tracks = [];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);

    return new MediaStream(tracks);
  }
}
