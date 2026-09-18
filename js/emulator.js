/**
 * js/emulator.js - Core NES Emulation Engine for Duplinha NES
 * Built on top of JSNES with 60 FPS WebGL/Canvas2D rendering,
 * circular-buffer Web Audio synthesis and WebRTC MediaStream broadcasting.
 */

class NesEmulator {
  constructor(canvasElement) {
    this.canvas = canvasElement;
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.canvas.width = 256;
    this.canvas.height = 240;

    // Fast 32-bit pixel buffer for 256x240 frame
    this.imageData = this.ctx.createImageData(256, 240);
    this.buf = new ArrayBuffer(this.imageData.data.length);
    this.buf8 = new Uint8ClampedArray(this.buf);
    this.buf32 = new Uint32Array(this.buf);
    for (let i = 0; i < this.buf32.length; i++) {
      this.buf32[i] = 0xFF000000; // Black opaque
    }

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

  _initNES() {
    this.nes = new jsnes.NES({
      onFrame: (frameBuffer) => {
        // Blit 256x240 32-bit pixel array directly to canvas
        for (let i = 0; i < 61440; i++) {
          this.buf32[i] = 0xFF000000 | frameBuffer[i];
        }
        this.imageData.data.set(this.buf8);
        this.ctx.putImageData(this.imageData, 0, 0);
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
