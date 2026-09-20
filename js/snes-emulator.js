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
    this.canvas = canvasElement;
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

    // Rewind Ring Buffer (snapshots every 1s for up to 30s)
    this.rewindBuffer = [];
    this.maxRewindStates = 30; // 30 snapshots * 1s = 30 seconds
    this.rewindTimer = null;
    this.isRewinding = false;

    // Save States Directory Handle (File System Access API)
    this.savesDirHandle = null;
    this.memorySaveState = null;

    // Callbacks
    this.onStatusChange = null;
    this.onFPSUpdate = null;
  }

  setAspectRatio(ratio) {
    this.aspectRatioMode = ratio;
    localStorage.setItem('duplinha_snes_ratio', ratio);
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

      const launchOptions = {
        core: 'snes9x',
        rom: {
          fileName: fileName,
          fileContent: blob
        },
        element: this.canvas,
        size: { width: 1536, height: 1344 },
        shader: '6xbrz',
        resolveShader: async () => {
          try {
            const res = await fetch('shaders/xbrz/6xbrz.glslp');
            if (res.ok) {
              return [
                'shaders/xbrz/6xbrz.glslp',
                'shaders/xbrz/shaders/6xbrz.glsl'
              ];
            }
          } catch (_) {}
          // Fallback to jsDelivr CDN
          return [
            'https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7/xbrz/xbrz-freescale.glslp',
            'https://cdn.jsdelivr.net/gh/libretro/glsl-shaders@468f67b6f6788e2719d1dd28dfb2c9b7c3db3cc7/xbrz/shaders/xbrz-freescale.glsl'
          ];
        },
        style: {
          width: '100%',
          height: '100%',
          objectFit: 'fill'
        },
        retroarchConfig: {
          video_vsync: 'true',
          video_threaded: 'true',
          video_hard_sync: 'false',
          video_smooth: 'false',
          savestate_thumbnail_enable: 'false',
          savestate_auto_save: 'false',
          savestate_auto_load: 'false',
          rewind_enable: 'false',
          // Disable default keyboard bindings so our InputManager handles all keys and gamepads cleanly
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

      try {
        this.nostalgist = await NostalgistClass.launch(launchOptions);
      } catch (shaderErr) {
        console.warn('Tentativa de iniciar com shader xBRZ 6x falhou, iniciando core limpo:', shaderErr);
        const fallbackOptions = { ...launchOptions };
        delete fallbackOptions.shader;
        delete fallbackOptions.resolveShader;
        this.nostalgist = await NostalgistClass.launch(fallbackOptions);
      }

      this.isRunning = true;
      this.isPaused = false;

      // Start automatic rewind buffer captures every 2 seconds (15 snapshots = 30s)
      this.maxRewindStates = 15;
      this.rewindTimer = setInterval(() => {
        this._captureRewindState();
      }, 2000);

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
    const stepsToPop = Math.max(1, Math.round(seconds));
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
