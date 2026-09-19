/**
 * js/clip-recorder.js - Rolling 10-Second Clip Recorder for Duplinha
 * Keeps a circular buffer of the last 10 seconds of gameplay and downloads
 * an instant WebM video clip on demand (Button or F9 shortcut).
 */

class ClipRecorder {
  constructor({ canvas, video, onStatusChange }) {
    this.canvas = canvas;
    this.video = video;
    this.onStatusChange = onStatusChange || console.log;

    this.mediaRecorder = null;
    this.chunks = [];
    this.maxChunks = 11; // ~10-11 seconds at 1s intervals
    this.isRecording = false;

    this._initRecorder();
    this._bindEvents();
  }

  _initRecorder() {
    try {
      if (typeof MediaRecorder === 'undefined') {
        console.warn('MediaRecorder não suportado neste navegador.');
        return;
      }

      // Priority: use video stream if client, or canvas stream if host
      let stream = null;
      if (this.video && this.video.style.display !== 'none' && this.video.srcObject) {
        stream = this.video.srcObject;
      } else if (this.canvas && this.canvas.captureStream) {
        stream = this.canvas.captureStream(30);
      }

      if (!stream) {
        // Will retry when ROM starts or stream arrives
        return;
      }

      const options = { mimeType: 'video/webm;codecs=vp8' };
      if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        delete options.mimeType;
      }

      this.mediaRecorder = new MediaRecorder(stream, options);

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          this.chunks.push(e.data);
          if (this.chunks.length > this.maxChunks) {
            this.chunks.shift();
          }
        }
      };

      this.mediaRecorder.onerror = (err) => {
        console.warn('Erro no MediaRecorder:', err);
      };

      // Request data chunks every 1000ms
      this.mediaRecorder.start(1000);
      this.isRecording = true;
      console.log('📹 ClipRecorder: Buffer rotativo de 10s ativado!');
    } catch (err) {
      console.warn('ClipRecorder não pôde ser iniciado automaticamente:', err);
    }
  }

  ensureStarted() {
    if (!this.isRecording) {
      this._initRecorder();
    }
  }

  _bindEvents() {
    // F9 shortcut to save clip
    window.addEventListener('keydown', (e) => {
      if (e.code === 'F9') {
        e.preventDefault();
        this.saveClip();
      }
    });

    // Button click listeners
    document.querySelectorAll('.btn-clip-save').forEach(btn => {
      btn.addEventListener('click', () => this.saveClip());
    });
  }

  saveClip() {
    this.ensureStarted();

    if (!this.chunks || this.chunks.length === 0) {
      this.onStatusChange('⚠️ Gravador iniciando... jogue mais alguns segundos antes de salvar o clipe!');
      return;
    }

    try {
      const blob = new Blob(this.chunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.style.display = 'none';
      a.href = url;
      const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      a.download = `duplinha-clipe-${dateStr}.webm`;
      document.body.appendChild(a);
      a.click();

      setTimeout(() => {
        URL.revokeObjectURL(url);
        a.remove();
      }, 1000);

      this.onStatusChange('📹 Clipe de 10 segundos salvo com sucesso!');
    } catch (err) {
      console.error('Falha ao salvar clipe:', err);
      this.onStatusChange('❌ Erro ao exportar clipe de vídeo.');
    }
  }
}
