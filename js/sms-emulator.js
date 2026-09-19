/**
 * js/sms-emulator.js - Sega Master System Emulator Engine for Duplinha Master
 * Powered by Nostalgist.js (Genesis Plus GX / Gearsystem Libretro Core).
 * Includes 60 FPS WebRTC AV streaming, P2P dual-player inputs, and persistent Save States.
 */

class SmsEmulator {
  constructor(canvas) {
    this.canvas = canvas;
    this.nostalgist = null;
    this.currentRomName = null;
    this.currentRomData = null;
    this.isRunning = false;
    this.isPaused = false;
    this.volume = 0.8;
    this.fps = 60;
    this.aspectRatio = 'superwide';
    this.cropOverscan = true;

    // Callbacks
    this.onStatusChange = null;
    this.onFPSUpdate = null;

    // Audio capture for WebRTC streaming
    this.audioCtx = null;
    this.mediaStreamDest = null;
    this._hookWebAudio();
  }

  /**
   * Intercepts AudioContext creations so we can capture the audio stream for WebRTC
   */
  _hookWebAudio() {
    const self = this;
    const OrigAudioContext = window.AudioContext || window.webkitAudioContext;
    if (OrigAudioContext && !window.__smsAudioHooked) {
      window.__smsAudioHooked = true;
      window.AudioContext = class extends OrigAudioContext {
        constructor(...args) {
          super(...args);
          self.audioCtx = this;
          try {
            self.mediaStreamDest = this.createMediaStreamDestination();
          } catch (e) {
            console.warn('Audio destination não pôde ser criada:', e);
          }
        }
      };
      window.webkitAudioContext = window.AudioContext;
    }
  }

  async loadROM(fileOrBlob, name) {
    this.currentRomName = name;
    this.currentRomData = fileOrBlob;

    if (this.nostalgist) {
      try {
        await this.nostalgist.destroy();
      } catch (_) {}
      this.nostalgist = null;
    }

    if (this.onStatusChange) {
      this.onStatusChange(`Carregando ${name}...`);
    }

    try {
      if (typeof Nostalgist === 'undefined') {
        throw new Error('Nostalgist.js não carregado. Verifique a conexão com a internet.');
      }

      // Configure Nostalgist with Genesis Plus GX core for Sega Master System
      this.nostalgist = await Nostalgist.launch({
        core: 'genesis_plus_gx',
        rom: fileOrBlob,
        element: this.canvas,
        retroarchConfig: {
          // Player 2 keys setup so Nostalgist registers port 2
          input_player2_a: 'x',
          input_player2_b: 'z',
          input_player2_start: 'enter',
          input_player2_up: 'up',
          input_player2_down: 'down',
          input_player2_left: 'left',
          input_player2_right: 'right',
        }
      });

      this.isRunning = true;
      this.isPaused = false;

      if (this.onStatusChange) {
        this.onStatusChange(`🎮 ${name} iniciado com sucesso!`);
      }
      return true;
    } catch (err) {
      console.error('Erro ao iniciar emulador Master System:', err);
      if (this.onStatusChange) {
        this.onStatusChange(`Erro ao iniciar: ${err.message || err}`);
      }
      return false;
    }
  }

  /**
   * Translates unified button names to Sega Master System actions
   */
  _mapButton(buttonName) {
    switch (buttonName) {
      case 'BUTTON_1':
      case 'BUTTON_A':
        return 'b'; // Primary action / Jump in SMS
      case 'BUTTON_2':
      case 'BUTTON_B':
        return 'a'; // Secondary action / Attack in SMS
      case 'BUTTON_START':
      case 'BUTTON_PAUSE':
        return 'start'; // Console Pause button
      case 'BUTTON_UP':
        return 'up';
      case 'BUTTON_DOWN':
        return 'down';
      case 'BUTTON_LEFT':
        return 'left';
      case 'BUTTON_RIGHT':
        return 'right';
      default:
        return null;
    }
  }

  buttonDown(player, buttonName) {
    if (!this.nostalgist) return;
    const btn = this._mapButton(buttonName);
    if (btn) {
      try {
        this.nostalgist.pressDown({ button: btn, player: player });
      } catch (e) {
        console.warn('pressDown error:', e);
      }
    }
  }

  buttonUp(player, buttonName) {
    if (!this.nostalgist) return;
    const btn = this._mapButton(buttonName);
    if (btn) {
      try {
        this.nostalgist.pressUp({ button: btn, player: player });
      } catch (e) {
        console.warn('pressUp error:', e);
      }
    }
  }

  async saveState() {
    if (!this.nostalgist) return false;
    try {
      const stateObj = await this.nostalgist.saveState();
      if (stateObj && stateObj.state && this.currentRomName) {
        // Convert Uint8Array to base64 for localStorage storage
        const blob = stateObj.state instanceof Blob ? stateObj.state : new Blob([stateObj.state]);
        const reader = new FileReader();
        reader.onload = () => {
          localStorage.setItem(`duplinha_sms_save_${this.currentRomName}`, reader.result);
        };
        reader.readAsDataURL(blob);
        return true;
      }
      return false;
    } catch (e) {
      console.error('Falha ao salvar estado SMS:', e);
      return false;
    }
  }

  async loadState() {
    if (!this.nostalgist || !this.currentRomName) return false;
    try {
      const savedDataUrl = localStorage.getItem(`duplinha_sms_save_${this.currentRomName}`);
      if (!savedDataUrl) return false;

      const res = await fetch(savedDataUrl);
      const blob = await res.blob();
      await this.nostalgist.loadState(blob);
      return true;
    } catch (e) {
      console.error('Falha ao carregar estado SMS:', e);
      return false;
    }
  }

  togglePause() {
    if (!this.nostalgist) return false;
    try {
      if (this.isPaused) {
        this.nostalgist.resume();
        this.isPaused = false;
      } else {
        this.nostalgist.pause();
        this.isPaused = true;
      }
    } catch (e) {
      console.warn('togglePause:', e);
    }
    return this.isPaused;
  }

  async reloadROM() {
    if (this.nostalgist) {
      try {
        await this.nostalgist.restart();
      } catch (e) {
        if (this.currentRomData && this.currentRomName) {
          await this.loadROM(this.currentRomData, this.currentRomName);
        }
      }
    }
  }

  setVolume(vol) {
    this.volume = Math.max(0, Math.min(1, vol));
    if (this.audioCtx) {
      // If we have a master gain
      if (this.masterGain) this.masterGain.gain.value = this.volume;
    }
  }

  setAspectRatio(ratio) {
    this.aspectRatio = ratio;
  }

  toggleCropOverscan() {
    this.cropOverscan = !this.cropOverscan;
    return this.cropOverscan;
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

    const audioTrack = (this.mediaStreamDest && this.mediaStreamDest.stream)
      ? this.mediaStreamDest.stream.getAudioTracks()[0]
      : null;

    const tracks = [];
    if (videoTrack) tracks.push(videoTrack);
    if (audioTrack) tracks.push(audioTrack);

    return new MediaStream(tracks);
  }
}
