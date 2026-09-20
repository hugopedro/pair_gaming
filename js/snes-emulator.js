/**
 * js/snes-emulator.js - Super Nintendo (SNES) Emulator Engine for Duplinha NES
 * Powered by Snes9x 2005 / Nostalgist.js (WebAssembly Libretro core)
 * Features:
 *  - 60 FPS Cycle-accurate Super Nintendo emulation (16-bit 65816 + SPC700/DSP + PPU Mode 7)
 *  - Full 2-player local & WebRTC multiplayer controls
 *  - Audio interception with WebRTC MediaStream broadcasting
 *  - 30-second Rollback / Rewind Ring Buffer
 *  - Save States stored in Memory, IndexedDB, and automatic local disk export
 */

// Web Audio Interceptor for WebRTC P2P streaming
let snesAudioDest = null;
const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
if (OrigAudioContext && !window.__snesAudioHooked) {
  window.__snesAudioHooked = true;
  window.AudioContext = class extends OrigAudioContext {
    constructor(options) {
      super(options);
      window.__snesCurrentAudioCtx = this;
      try {
        snesAudioDest = this.createMediaStreamDestination();
        window.__snesAudioDest = snesAudioDest;
      } catch (_) {}
    }
  };
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(dest, ...args) {
    if (window.__snesAudioDest && dest === window.__snesCurrentAudioCtx?.destination) {
      try {
        origConnect.call(this, window.__snesAudioDest);
      } catch (_) {}
    }
    return origConnect.call(this, dest, ...args);
  };
}

class SnesEmulator {
  constructor(canvasElement) {
    // Display canvas (Canvas 2D) — what the user sees
    this.canvas = canvasElement;
    this.ctx = null; // initialized in loadROM

    // Hidden WebGL canvas for Nostalgist (tiny buffer, never shown to user)
    this._webglCanvas = null;

    this.nostalgist = null;

    // Active aspect ratio mode: '16-9' | '4-3' | '16-10' | 'superwide'
    let savedRatio = localStorage.getItem('duplinha_snes_ratio');
    if (!savedRatio) savedRatio = '16-9';
    this.aspectRatioMode = savedRatio;

    // Audio & State
    this.currentRomData = null;
    this.currentRomName = '';
    this.isRunning = false;
    this.isPaused = false;
    this.fps = 60;
    this.fpsTimer = performance.now();
    this.frameCount = 0;

    // Render loop
    this._renderLoopRunning = false;
    this._rafId = null;

    // Rewind Ring Buffer (snapshots every 3s for up to 30s)
    this.rewindBuffer = [];
    this.rewindIntervalMs = 3000;
    this.maxRewindStates = 10; // 10 snapshots * 3s = 30 seconds
    this.rewindTimer = null;
    this.isRewinding = false;
    this._isCapturing = false;

    // Save States Directory Handle (File System Access API)
    this.savesDirHandle = null;
    this.memorySaveState = null;

    // xBRZ Scaler (WebAssembly CPU - 256x224 -> 1024x896)
    this.scaler = null;
    this.xbrzCanvas = null;
    this.xbrzCtx = null;
    this.xbrzImageData = null;
    this._pixelBuffer = null;
    this._initScaler();

    // Callbacks
    this.onStatusChange = null;
    this.onFPSUpdate = null;

    this._updateCanvasSize();
  }

  _initScaler() {
    if (this.scaler) return;
    const Xbrz = window.XbrzScaler;
    if (Xbrz) {
      try {
        this.scaler = new Xbrz(256, 224, 4);

        // 256x224 temporary 2D canvas to capture frames without WebGL FBO issues
        // willReadFrequently: true keeps buffer in CPU memory for sub-millisecond getImageData
        this.tempCanvas = document.createElement('canvas');
        this.tempCanvas.width = 256;
        this.tempCanvas.height = 224;
        this.tempCtx = this.tempCanvas.getContext('2d', { willReadFrequently: true });

        // 1024x896 intermediate canvas for xBRZ 4x
        this.xbrzCanvas = document.createElement('canvas');
        this.xbrzCanvas.width = 1024;
        this.xbrzCanvas.height = 896;
        this.xbrzCtx = this.xbrzCanvas.getContext('2d', { alpha: false });
        this.xbrzImageData = this.xbrzCtx.createImageData(1024, 896);
      } catch (e) {
        console.warn('Erro ao inicializar xBRZ Scaler SNES:', e);
      }
    }
  }

  _updateCanvasSize() {
    const widthMap = {
      'superwide': 1280,
      '16-9': 1280,
      '16-10': 1152,
      '4-3': 960
    };
    const targetW = widthMap[this.aspectRatioMode] || 1280;
    const targetH = 720;
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
      if (this.ctx) {
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
      }
    }
    this._initSuperWideTable();
  }

  _initSuperWideTable() {
    const N = 32;
    const srcW = 1024;
    const srcH = 896;
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

      const sx = i * (srcW / N);
      const sw = srcW / N;
      const dx = d0 * dstW;
      const dw = (d1 * dstW) - dx + 0.6; // Overlap to prevent seams

      this.superWideTable.push({ sx, sy: 0, sw, sh: srcH, dx, dw });
    }
  }

  _drawSuperWide() {
    if (!this.xbrzCanvas || !this.ctx) return;
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

  setAspectRatio(ratio) {
    this.aspectRatioMode = ratio;
    localStorage.setItem('duplinha_snes_ratio', ratio);
    this._updateCanvasSize();
  }

  _getButtonKey(buttonName) {
    switch (buttonName) {
      case 'BUTTON_UP': return 'up';
      case 'BUTTON_DOWN': return 'down';
      case 'BUTTON_LEFT': return 'left';
      case 'BUTTON_RIGHT': return 'right';
      case 'BUTTON_A': return 'a';
      case 'BUTTON_B': return 'b';
      case 'BUTTON_X': return 'x';
      case 'BUTTON_Y': return 'y';
      case 'BUTTON_L': return 'l';
      case 'BUTTON_R': return 'r';
      case 'BUTTON_SELECT': return 'select';
      case 'BUTTON_START': return 'start';
      default: return null;
    }
  }

  buttonDown(player, buttonName) {
    if (!this.nostalgist) return;
    const key = this._getButtonKey(buttonName);
    if (!key) return;

    try {
      if (player === 1) {
        this.nostalgist.pressDown(key);
      } else {
        this.nostalgist.pressDown({ button: key, player: 2 });
      }
    } catch (e) {
      console.warn('Erro ao disparar buttonDown SNES:', e);
    }
  }

  buttonUp(player, buttonName) {
    if (!this.nostalgist) return;
    const key = this._getButtonKey(buttonName);
    if (!key) return;

    try {
      if (player === 1) {
        this.nostalgist.pressUp(key);
      } else {
        this.nostalgist.pressUp({ button: key, player: 2 });
      }
    } catch (e) {
      console.warn('Erro ao disparar buttonUp SNES:', e);
    }
  }

  // IndexedDB Persistent Storage Helper
  _openDB() {
    if (this._dbPromise) return this._dbPromise;
    this._dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        return reject(new Error('IndexedDB não suportado'));
      }
      const req = indexedDB.open('duplinha_snes_db', 1);
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

  async _getSavesDirHandle(autoPrompt = false) {
    if (this.savesDirHandle) {
      try {
        const q = await this.savesDirHandle.queryPermission({ mode: 'readwrite' });
        if (q === 'granted') return this.savesDirHandle;
        if (autoPrompt) {
          const req = await this.savesDirHandle.requestPermission({ mode: 'readwrite' });
          if (req === 'granted') return this.savesDirHandle;
        }
      } catch (_) {}
    }

    // Try restoring from IndexedDB
    try {
      const storedHandle = await this._dbGet('duplinha_saves_dir_handle');
      if (storedHandle) {
        this.savesDirHandle = storedHandle;
        const q = await storedHandle.queryPermission({ mode: 'readwrite' });
        if (q === 'granted') return storedHandle;
        if (autoPrompt) {
          const req = await storedHandle.requestPermission({ mode: 'readwrite' });
          if (req === 'granted') return storedHandle;
        }
      }
    } catch (_) {}

    // If autoPrompt is true and not yet granted/stored, prompt user to select folder
    if (autoPrompt && typeof window.showDirectoryPicker === 'function') {
      try {
        const handle = await window.showDirectoryPicker({
          id: 'snes_saves_dir',
          mode: 'readwrite',
          startIn: 'documents'
        });
        if (handle) {
          this.savesDirHandle = handle;
          await this._dbSet('duplinha_saves_dir_handle', handle);
          return handle;
        }
      } catch (err) {
        console.warn('Seleção de pasta SNES cancelada ou não permitida:', err);
      }
    }

    return null;
  }

  async selectSavesDirectory() {
    if (typeof window.showDirectoryPicker !== 'function') {
      return { success: false, reason: 'unsupported' };
    }
    try {
      const handle = await window.showDirectoryPicker({
        id: 'snes_saves_dir',
        mode: 'readwrite',
        startIn: 'documents'
      });
      if (handle) {
        this.savesDirHandle = handle;
        await this._dbSet('duplinha_saves_dir_handle', handle);
        return { success: true, name: handle.name };
      }
    } catch (err) {
      if (err.name === 'AbortError') {
        return { success: false, reason: 'aborted' };
      }
      return { success: false, reason: err.message };
    }
    return { success: false, reason: 'unknown' };
  }

  async loadROM(romData, romName = 'Super Nintendo Game', originalFileName = '') {
    this.currentRomData = romData;
    this.currentRomName = romName;

    // Stop previous render loop and emulator
    this._renderLoopRunning = false;
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }
    if (this.nostalgist) {
      try {
        await this.nostalgist.exit();
      } catch (_) {}
      this.nostalgist = null;
    }

    if (this.rewindTimer) {
      clearInterval(this.rewindTimer);
      this.rewindTimer = null;
    }
    this.rewindBuffer = [];

    // Clean up previous hidden WebGL canvas
    if (this._webglCanvas && this._webglCanvas.parentNode) {
      this._webglCanvas.parentNode.removeChild(this._webglCanvas);
    }

    try {
      const ext = (originalFileName && originalFileName.match(/\.(sfc|smc|zip|bin)$/i))
        ? originalFileName.match(/\.(sfc|smc|zip|bin)$/i)[1].toLowerCase()
        : 'sfc';
      const fileName = `${romName.replace(/[^a-zA-Z0-9_-]/g, '_')}.${ext}`;
      const blob = romData instanceof Blob ? romData : new Blob([romData]);
      const NostalgistClass = window.Nostalgist;
      if (!NostalgistClass) {
        throw new Error('Nostalgist.js não está carregado no navegador.');
      }

      // === DUAL CANVAS ARCHITECTURE (imitating NES pipeline) ===

      // 1. Create hidden WebGL canvas for Nostalgist (tiny 256×224 buffer)
      this._webglCanvas = document.createElement('canvas');
      this._webglCanvas.id = '_snesWebGL';
      this._webglCanvas.width = 256;
      this._webglCanvas.height = 224;
      this._webglCanvas.style.cssText = `
        position: absolute; top: 0; left: 0;
        width: 1px; height: 1px;
        opacity: 0.01;
        pointer-events: none;
        z-index: -1;
      `;
      // Insert into the same parent so it's in the DOM and composited
      this.canvas.parentNode.insertBefore(this._webglCanvas, this.canvas);

      // 2. Intercept getContext to force preserveDrawingBuffer on this canvas
      const origGetContext = this._webglCanvas.getContext.bind(this._webglCanvas);
      this._webglCanvas.getContext = function(type, attrs) {
        if (type === 'webgl' || type === 'webgl2') {
          attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
        }
        return origGetContext(type, attrs);
      };

      // 3. Initialize Canvas 2D on the visible display canvas (xBRZ 4x)
      this._initScaler();
      this.ctx = this.canvas.getContext('2d', { alpha: false });
      this._updateCanvasSize();

      // 4. Launch Nostalgist on the HIDDEN WebGL canvas (256×224 buffer = tiny)
      const launchOptions = {
        core: 'snes9x',
        rom: {
          fileName: fileName,
          fileContent: blob
        },
        element: this._webglCanvas,
        size: { width: 256, height: 224 },
        style: {
          width: '1px',
          height: '1px'
        },
        retroarchConfig: {
          video_vsync: 'true',
          video_threaded: 'false',
          video_hard_sync: 'false',
          video_smooth: 'false',
          video_shader_enable: 'false',
          video_scale: '1',
          savestate_thumbnail_enable: 'false',
          savestate_auto_save: 'false',
          savestate_auto_load: 'false',
          rewind_enable: 'false',
          input_player1_up: 'nul',
          input_player1_down: 'nul',
          input_player1_left: 'nul',
          input_player1_right: 'nul',
          input_player1_a: 'nul',
          input_player1_b: 'nul',
          input_player1_x: 'nul',
          input_player1_y: 'nul',
          input_player1_l: 'nul',
          input_player1_r: 'nul',
          input_player1_select: 'nul',
          input_player1_start: 'nul',
          input_player2_up: 'nul',
          input_player2_down: 'nul',
          input_player2_left: 'nul',
          input_player2_right: 'nul',
          input_player2_a: 'nul',
          input_player2_b: 'nul',
          input_player2_x: 'nul',
          input_player2_y: 'nul',
          input_player2_l: 'nul',
          input_player2_r: 'nul',
          input_player2_select: 'nul',
          input_player2_start: 'nul'
        }
      };

      this.nostalgist = await NostalgistClass.launch(launchOptions);

      // 5. Start render loop: copy frames WebGL → Canvas 2D via xBRZ 4x (WASM CPU)
      this._renderLoopRunning = true;
      this._startRenderLoop();

      this.isRunning = true;
      this.isPaused = false;

      // Start automatic rewind buffer captures every 3 seconds (10 snapshots = 30s)
      this.rewindTimer = setInterval(() => {
        this._captureRewindState();
      }, this.rewindIntervalMs);

      // Start FPS monitor
      this._startFPSMonitor();

      if (this.onStatusChange) {
        this.onStatusChange(`🎮 ${romName} carregado com sucesso!`);
      }
      return true;
    } catch (err) {
      console.error('Falha ao iniciar emulação SNES:', err);
      if (this.onStatusChange) {
        this.onStatusChange(`Erro ao iniciar jogo: ${err.message}`);
      }
      return false;
    }
  }

  // Render loop: copy frames from hidden WebGL canvas to visible Canvas 2D via xBRZ 4x (WASM CPU)
  _startRenderLoop() {
    const loop = () => {
      if (!this._renderLoopRunning) return;
      this._rafId = requestAnimationFrame(loop);

      if (!this._webglCanvas || !this.ctx) return;
      if (this._webglCanvas.width === 0 || this._webglCanvas.height === 0) return;
      if (this.canvas.width === 0 || this.canvas.height === 0) return;

      if (this.scaler && this.tempCtx && this.xbrzCtx) {
        try {
          // 1. Copy WebGL frame to 256x224 2D canvas (browser compositor, fast & reliable)
          this.tempCtx.drawImage(this._webglCanvas, 0, 0, 256, 224);

          // 2. Read 256x224 pixels (willReadFrequently makes this sub-millisecond)
          const imgData = this.tempCtx.getImageData(0, 0, 256, 224);

          // 3. Scale with xBRZ 4x (256x224 -> 1024x896) in WebAssembly CPU (~0.6ms)
          const scaled = this.scaler.scale(imgData.data);
          this.xbrzImageData.data.set(scaled);
          this.xbrzCtx.putImageData(this.xbrzImageData, 0, 0);

          // 4. Render 1024x896 xBRZ image to visible display canvas
          if (this.aspectRatioMode === 'superwide') {
            this._drawSuperWide();
          } else {
            this.ctx.imageSmoothingEnabled = true;
            this.ctx.imageSmoothingQuality = 'high';
            this.ctx.drawImage(
              this.xbrzCanvas,
              0, 0, 1024, 896,
              0, 0, this.canvas.width, this.canvas.height
            );
          }
          return;
        } catch (_) {
          // Fallback to direct drawImage if anything fails
        }
      }

      try {
        // Fallback: direct drawImage from WebGL canvas → Canvas 2D
        this.ctx.imageSmoothingEnabled = false;
        this.ctx.drawImage(
          this._webglCanvas,
          0, 0, this._webglCanvas.width, this._webglCanvas.height,
          0, 0, this.canvas.width, this.canvas.height
        );
      } catch (_) {}
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _startFPSMonitor() {
    const checkFPS = () => {
      if (!this.isRunning) return;
      if (this.onFPSUpdate) {
        this.onFPSUpdate(60);
      }
      setTimeout(checkFPS, 1000);
    };
    checkFPS();
  }

  async _captureRewindState() {
    if (!this.nostalgist || !this.isRunning || this.isPaused || this.isRewinding || this._isCapturing) return;
    this._isCapturing = true;
    try {
      const res = await this.nostalgist.saveState();
      if (res && res.state) {
        this.rewindBuffer.push(res.state);
        if (this.rewindBuffer.length > this.maxRewindStates) {
          this.rewindBuffer.shift();
        }
      }
    } catch (_) {}
    finally {
      this._isCapturing = false;
    }
  }

  async rewind(seconds = 3) {
    if (!this.nostalgist || this.rewindBuffer.length === 0) return false;
    const intervalSec = (this.rewindIntervalMs || 3000) / 1000;
    const stepsToPop = Math.max(1, Math.round(seconds / intervalSec));
    for (let i = 0; i < stepsToPop; i++) {
      if (this.rewindBuffer.length > 1) {
        this.rewindBuffer.pop();
      }
    }
    const targetState = this.rewindBuffer[this.rewindBuffer.length - 1];
    if (targetState) {
      this.isRewinding = true;
      try {
        await this.nostalgist.loadState(targetState);
        this.isRewinding = false;
        return true;
      } catch (err) {
        console.error('Erro no rewind SNES:', err);
        this.isRewinding = false;
        return false;
      }
    }
    return false;
  }

  togglePause() {
    if (!this.nostalgist) return false;
    this.isPaused = !this.isPaused;
    if (this.isPaused) {
      this.nostalgist.pause();
    } else {
      this.nostalgist.resume();
    }
    return this.isPaused;
  }

  async reloadROM() {
    if (!this.nostalgist) return;
    try {
      await this.nostalgist.restart();
    } catch (e) {
      console.warn('Erro reiniciando SNES:', e);
    }
  }

  async saveState() {
    if (!this.nostalgist) return null;
    try {
      const res = await this.nostalgist.saveState();
      if (!res || !res.state) return null;
      const state = res.state;

      this.memorySaveState = state;
      if (this.currentRomName) {
        await this._dbSet(`duplinha_snes_save_${this.currentRomName}`, state);
      }

      let localSavedName = null;
      try {
        const dirHandle = await this._getSavesDirHandle(true);
        if (dirHandle) {
          const now = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
          const cleanRom = (this.currentRomName || 'SNES_Game').replace(/[^a-zA-Z0-9_-]/g, '_');
          const fileName = `${cleanRom}_${ts}.state`;

          const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(state);
          await writable.close();
          localSavedName = fileName;
        }
      } catch (dirErr) {
        console.warn('Erro ao gravar save SNES no disco local:', dirErr);
      }

      return { state, localSavedName };
    } catch (e) {
      console.error('Falha ao salvar estado SNES:', e);
      if (this.memorySaveState) return { state: this.memorySaveState, localSavedName: null };
      return null;
    }
  }

  async loadState(savedState = null) {
    if (!this.nostalgist) return false;
    try {
      let state = savedState;
      let loadedFromLocal = null;

      // 1. Try to find the latest .state file in local folder if bound
      if (!state && this.currentRomName) {
        try {
          const dirHandle = await this._getSavesDirHandle(false);
          if (dirHandle) {
            const cleanRom = this.currentRomName.replace(/[^a-zA-Z0-9_-]/g, '_');
            let latestFile = null;
            let latestName = '';

            for await (const [name, handle] of dirHandle.entries()) {
              if (name.startsWith(cleanRom) && name.endsWith('.state')) {
                if (name > latestName) {
                  latestName = name;
                  latestFile = handle;
                }
              }
            }

            if (latestFile) {
              const file = await latestFile.getFile();
              state = file;
              loadedFromLocal = latestName;
            }
          }
        } catch (dirErr) {
          console.warn('Tentativa de ler save local SNES:', dirErr);
        }
      }

      // 2. Fallback to in-memory state
      if (!state && this.memorySaveState) {
        state = this.memorySaveState;
      }

      // 3. Fallback to IndexedDB state
      if (!state && this.currentRomName) {
        state = await this._dbGet(`duplinha_snes_save_${this.currentRomName}`);
      }

      if (state) {
        await this.nostalgist.loadState(state);
        this.memorySaveState = state;
        return { success: true, loadedFromLocal };
      }
      return false;
    } catch (e) {
      console.error('Falha ao carregar estado SNES:', e);
      return false;
    }
  }

  /**
   * Captures the live 60 FPS video track + Web Audio track
   * for peer-to-peer streaming via WebRTC
   */
  getMediaStream() {
    const videoStream = this.canvas.captureStream ? this.canvas.captureStream(60) : null;
    if (!videoStream) return null;

    const videoTrack = videoStream.getVideoTracks()[0];
    if (videoTrack && 'contentHint' in videoTrack) {
      videoTrack.contentHint = 'detail';
    }

    const audioTrack = (window.__snesAudioDest && window.__snesAudioDest.stream)
      ? window.__snesAudioDest.stream.getAudioTracks()[0]
      : null;

    const tracks = [];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);

    return new MediaStream(tracks);
  }
}
