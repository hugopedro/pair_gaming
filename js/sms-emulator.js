/**
 * js/sms-emulator.js - Sega Master System Pure JavaScript Emulator Engine
 * Powered by Miracle SMS Core (100% Offline, Zero WebAssembly/CORS issues).
 * Features:
 *  - 60 FPS Accurate Z80 + VDP + SN76489 Sound Engine
 *  - Real-time xBRZ 6x WebAssembly Pixel Scaler (256x192 -> 1536x1152)
 *  - SuperWide 16:9 Non-linear Edge Stretch (center 4:3 preserved)
 *  - Web Audio stereo synthesis with WebRTC MediaStream broadcasting
 *  - Dual-controller P2P input mapping with Active-Low SMS joystick bitmasks
 *  - Instantaneous Save / Load States stored in LocalStorage (LB / RB)
 */

class SmsEmulator {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false });

    // Active aspect ratio mode: '16-9' | '4-3' | '16-10' | 'superwide'
    let savedRatio = localStorage.getItem('duplinha_sms_ratio');
    if (!savedRatio || savedRatio === 'superwide') savedRatio = '16-9';
    this.aspectRatioMode = savedRatio;
    this.cropOverscan = false; // Always false for Master System so HUD/score is never cut

    // xBRZ 6x High-Performance Scaler (256x192 -> 1536x1152)
    this.scaler = null;
    try {
      if (typeof XbrzScaler !== 'undefined') {
        this.scaler = new XbrzScaler(256, 192, 6);
      }
    } catch (e) {
      console.warn('xBRZ Scaler não pôde ser iniciado, usando bilinear padrão:', e);
    }

    // Intermediate 1536x1152 canvas for xBRZ
    this.xbrzCanvas = document.createElement('canvas');
    this.xbrzCanvas.width = 1536;
    this.xbrzCanvas.height = 1152;
    this.xbrzCtx = this.xbrzCanvas.getContext('2d', { alpha: false });
    this.xbrzImageData = this.xbrzCtx.createImageData(1536, 1152);

    // Raw 256x192 Master System frame buffer (32-bit ARGB/ABGR)
    this.fb32 = new Uint32Array(256 * 192);
    this.buf8 = new Uint8ClampedArray(this.fb32.buffer);
    for (let i = 0; i < this.fb32.length; i++) {
      this.fb32[i] = 0xFF000000; // Black opaque
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
    this.volume = 0.8;
    this.isMuted = false;

    // Emulator Core
    this.sms = null;
    this.soundChip = null;
    this.currentRomData = null;
    this.currentRomName = '';
    this.isRunning = false;
    this.isPaused = false;
    this.animationFrameId = null;
    this.lastFrameTime = 0;
    this.fps = 60;
    this.frameCount = 0;
    this.fpsTimer = performance.now();
    this.turboA = { 1: false, 2: false };
    this.turboB = { 1: false, 2: false };

    // Callbacks
    this.onStatusChange = null;
    this.onFPSUpdate = null;

    this._initSMS();
  }

  _updateCanvasSize() {
    const widthMap = {
      'superwide': 1280,
      '16-9': 1280,
      '16-10': 1152,
      '4-3': 960,
      'original': 960
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
    localStorage.setItem('duplinha_sms_crop_overscan', this.cropOverscan ? 'true' : 'false');
    this._initSuperWideTable();
    return this.cropOverscan;
  }

  _initSuperWideTable() {
    const N = 32;
    // Master System overscan: 8 px left/right (48px at 6x), 8 px top/bottom (48px at 6x)
    const srcX0 = this.cropOverscan ? 48 : 0;
    const srcY0 = this.cropOverscan ? 48 : 0;
    const srcW = this.cropOverscan ? (1536 - 96) : 1536;
    const srcH = this.cropOverscan ? (1152 - 96) : 1152;
    const dstW = this.canvas.width;
    const a = 0.75; // Preserves 4:3 scale at center
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
      const dw = (d1 * dstW) - dx + 0.6; // Slight overlap to prevent seams

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

  _initSMS() {
    if (typeof SMS === 'undefined' || typeof SoundChip === 'undefined') {
      console.error('SMS ou SoundChip não carregado!');
      return;
    }
    this.soundChip = new SoundChip(44100, SMS.CPU_HZ);
    this.sms = new SMS();
    this.sms.init(this.canvas, this.fb32, () => this._onFrame(), this.soundChip);
  }

  _onFrame() {
    // 1. Scale with xBRZ 6x (256x192 -> 1536x1152)
    if (this.scaler) {
      try {
        const scaled = this.scaler.scale(this.buf8);
        this.xbrzImageData.data.set(scaled);
        this.xbrzCtx.putImageData(this.xbrzImageData, 0, 0);
      } catch (e) {
        console.warn('xBRZ scale error:', e);
      }
    }

    // 2. Render to final canvas (SuperWide non-linear or standard aspect ratio)
    if (this.aspectRatioMode === 'superwide') {
      this._drawSuperWide();
    } else {
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'high';
      const sx = this.cropOverscan ? 48 : 0;
      const sy = this.cropOverscan ? 48 : 0;
      const sw = this.cropOverscan ? (1536 - 96) : 1536;
      const sh = this.cropOverscan ? (1152 - 96) : 1152;
      this.ctx.drawImage(this.xbrzCanvas, sx, sy, sw, sh, 0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _initAudioContext() {
    if (this.audioCtx) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    this.audioCtx = new AudioContextClass({ sampleRate: 44100 });
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

      if (this.soundChip && this.isRunning && !this.isPaused) {
        this.soundChip.render(outL, 0, len);
        outR.set(outL);
      } else {
        outL.fill(0);
        outR.fill(0);
      }
    };

    // Connect node to local speakers and WebRTC stream
    this.audioNode.connect(this.audioGain);
    this.audioGain.connect(this.audioCtx.destination);
    this.audioGain.connect(this.mediaStreamDest);
  }

  async loadROM(fileOrBlobOrString, romName = 'Jogo Master System') {
    this._initAudioContext();
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }

    if (!this.sms) {
      this._initSMS();
    }

    let binaryString = '';

    try {
      if (typeof fileOrBlobOrString === 'string') {
        binaryString = fileOrBlobOrString;
      } else if (fileOrBlobOrString instanceof ArrayBuffer) {
        const u8 = new Uint8Array(fileOrBlobOrString);
        const len = u8.length;
        const CHUNK_SIZE = 32768;
        for (let i = 0; i < len; i += CHUNK_SIZE) {
          const chunk = u8.subarray(i, Math.min(i + CHUNK_SIZE, len));
          binaryString += String.fromCharCode.apply(null, chunk);
        }
      } else if (fileOrBlobOrString instanceof Blob || fileOrBlobOrString instanceof File) {
        const buffer = await fileOrBlobOrString.arrayBuffer();
        const u8 = new Uint8Array(buffer);
        const len = u8.length;
        const CHUNK_SIZE = 32768;
        for (let i = 0; i < len; i += CHUNK_SIZE) {
          const chunk = u8.subarray(i, Math.min(i + CHUNK_SIZE, len));
          binaryString += String.fromCharCode.apply(null, chunk);
        }
      }

      // Strip 512-byte copier header if present
      if (binaryString.length % 16384 === 512) {
        binaryString = binaryString.substring(512);
      }

      this.currentRomData = binaryString;
      this.currentRomName = romName;

      this.sms.reset();
      this.sms.loadRom(romName, binaryString);
      this.sms.joystick = 0xFFFF; // All buttons unpressed (Active LOW)

      this.start();
      if (this.onStatusChange) this.onStatusChange(`ROM Carregada: ${romName}`);
      return true;
    } catch (err) {
      console.error('Erro ao carregar ROM no Master System:', err);
      if (this.onStatusChange) this.onStatusChange(`Erro: ${err.message || err}`);
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
        const sc = this.soundChip;
        // Handle Turbo buttons
        if (this.turboA[1]) {
          if (this.frameCount % 4 < 2) this.sms.joystick &= ~(1 << 4);
          else this.sms.joystick |= (1 << 4);
        }
        if (this.turboB[1]) {
          if (this.frameCount % 4 < 2) this.sms.joystick &= ~(1 << 5);
          else this.sms.joystick |= (1 << 5);
        }
        if (this.turboA[2]) {
          if (this.frameCount % 4 < 2) this.sms.joystick &= ~(1 << 10);
          else this.sms.joystick |= (1 << 10);
        }
        if (this.turboB[2]) {
          if (this.frameCount % 4 < 2) this.sms.joystick &= ~(1 << 11);
          else this.sms.joystick |= (1 << 11);
        }

        // Sega Master System runs 313 scanlines per frame
        for (let l = 0; l < 313; l++) {
          this.sms.runLine(tstates => sc.polltime(tstates));
        }
        this.frameCount++;
      } catch (err) {
        console.error('Erro na execução do frame SMS:', err);
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

  /**
   * Translates unified button names to active-low bitmask in SMS joystick register
   * Port $DC:
   *   Bit 0: P1 Up
   *   Bit 1: P1 Down
   *   Bit 2: P1 Left
   *   Bit 3: P1 Right
   *   Bit 4: P1 Button 1
   *   Bit 5: P1 Button 2
   *   Bit 6: P2 Up
   *   Bit 7: P2 Down
   * Port $DD:
   *   Bit 0: P2 Left (bit 8)
   *   Bit 1: P2 Right (bit 9)
   *   Bit 2: P2 Button 1 (bit 10)
   *   Bit 3: P2 Button 2 (bit 11)
   */
  _getButtonMask(player, buttonName) {
    if (player === 1) {
      switch (buttonName) {
        case 'BUTTON_UP': return 1 << 0;
        case 'BUTTON_DOWN': return 1 << 1;
        case 'BUTTON_LEFT': return 1 << 2;
        case 'BUTTON_RIGHT': return 1 << 3;
        case 'BUTTON_1':
        case 'BUTTON_A': return 1 << 4;
        case 'BUTTON_2':
        case 'BUTTON_B': return 1 << 5;
        default: return 0;
      }
    } else {
      switch (buttonName) {
        case 'BUTTON_UP': return 1 << 6;
        case 'BUTTON_DOWN': return 1 << 7;
        case 'BUTTON_LEFT': return 1 << 8;
        case 'BUTTON_RIGHT': return 1 << 9;
        case 'BUTTON_1':
        case 'BUTTON_A': return 1 << 10;
        case 'BUTTON_2':
        case 'BUTTON_B': return 1 << 11;
        default: return 0;
      }
    }
  }

  buttonDown(player, buttonName) {
    if (!this.sms) return;

    // Master System Console Pause button (NMI)
    if (buttonName === 'BUTTON_START' || buttonName === 'BUTTON_PAUSE') {
      this.sms.nmi();
      return;
    }

    if (buttonName === 'BUTTON_TURBO_A') {
      this.turboA[player] = true;
      return;
    }
    if (buttonName === 'BUTTON_TURBO_B') {
      this.turboB[player] = true;
      return;
    }

    const mask = this._getButtonMask(player, buttonName);
    if (mask) {
      // Active LOW: 0 = pressed
      this.sms.joystick &= ~mask;
    }
  }

  buttonUp(player, buttonName) {
    if (!this.sms) return;

    if (buttonName === 'BUTTON_TURBO_A') {
      this.turboA[player] = false;
      const mask = player === 1 ? (1 << 4) : (1 << 10);
      this.sms.joystick |= mask;
      return;
    }
    if (buttonName === 'BUTTON_TURBO_B') {
      this.turboB[player] = false;
      const mask = player === 1 ? (1 << 5) : (1 << 11);
      this.sms.joystick |= mask;
      return;
    }

    const mask = this._getButtonMask(player, buttonName);
    if (mask) {
      // Active LOW: 1 = released
      this.sms.joystick |= mask;
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

  async saveState() {
    if (!this.sms) return false;
    try {
      const state = this.sms.saveState();
      if (state && this.currentRomName) {
        const stateStr = JSON.stringify(state);
        localStorage.setItem(`duplinha_sms_save_${this.currentRomName}`, stateStr);
        return true;
      }
      return false;
    } catch (e) {
      console.error('Falha ao salvar estado SMS:', e);
      return false;
    }
  }

  async loadState() {
    if (!this.sms || !this.currentRomName) return false;
    try {
      const stored = localStorage.getItem(`duplinha_sms_save_${this.currentRomName}`);
      if (!stored) return false;
      const state = JSON.parse(stored);
      if (state) {
        this.sms.loadState(state);
        return true;
      }
      return false;
    } catch (e) {
      console.error('Falha ao carregar estado SMS:', e);
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
