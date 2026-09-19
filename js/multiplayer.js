/**
 * js/multiplayer.js - WebRTC P2P Multiplayer System for Duplinha NES
 * Uses PeerJS for signaling, RTCDataChannel for low-latency input streaming,
 * and WebRTC MediaStream for zero-desync 60 FPS video/audio broadcasting.
 */

class MultiplayerManager {
  constructor({ onRemoteInput, onRemoteStream, onStatusChange, onPingUpdate }) {
    this.peer = null;
    this.conn = null;
    this.call = null;
    this.mode = 'OFFLINE'; // 'OFFLINE' | 'HOST' | 'CLIENT'
    this.roomId = null;
    this.isConnected = false;
    this.ping = 0;
    this.pingInterval = null;

    // Callbacks
    this.onRemoteInput = onRemoteInput;     // (buttonName, isDown) => {}
    this.onRemoteStream = onRemoteStream;   // (mediaStream) => {}
    this.onStatusChange = onStatusChange;   // (statusText, mode) => {}
    this.onPingUpdate = onPingUpdate;       // (pingMs) => {}
    this.onAspectRatioChange = null;        // (ratio) => {}
    this.currentRatio = '4-3';
  }

  createRoom(getLocalMediaStream) {
    this._cleanup();
    this.mode = 'HOST';

    const randomSuffix = Math.random().toString(36).substring(2, 7);
    const generatedId = `duplinha-${randomSuffix}`;

    this.peer = new Peer(generatedId, {
      debug: 1
    });

    if (this.onStatusChange) {
      this.onStatusChange('Criando sala...', 'WAITING');
    }

    this.peer.on('open', (id) => {
      this.roomId = id;
      console.log('Sala Host criada com ID:', id);
      if (this.onStatusChange) {
        this.onStatusChange('Aguardando Player 2...', 'WAITING');
      }
    });

    // Handle Client connecting via DataChannel
    this.peer.on('connection', (connection) => {
      this.conn = connection;
      this._setupHostDataConnection(getLocalMediaStream);
    });

    this.peer.on('error', (err) => {
      console.error('Erro no PeerJS Host:', err);
      if (this.onStatusChange) {
        this.onStatusChange(`Erro: ${err.type || err.message}`, 'OFFLINE');
      }
    });
  }

  _setupHostDataConnection(getLocalMediaStream) {
    this.conn.on('open', () => {
      this.isConnected = true;
      console.log('Player 2 conectado no canal de dados!');
      if (this.onStatusChange) {
        this.onStatusChange('Player 2 Conectado!', 'ONLINE');
      }

      // Initiate WebRTC Call to stream Canvas + WebAudio to Player 2
      if (getLocalMediaStream) {
        const stream = getLocalMediaStream();
        if (stream) {
          console.log('Iniciando transmissão de vídeo/áudio P2P para o Player 2...');
          this.call = this.peer.call(this.conn.peer, stream);
          this.call.on('error', (e) => console.error('Erro na chamada P2P:', e));

          // Optimize WebRTC stream parameters (bitrate cap + anti-blur)
          this._optimizePeerConnection(this.call.peerConnection);
        }
      }

      this._startPingMonitor();
      this.sendAspectRatio(this.currentRatio);
    });

    this.conn.on('data', (data) => {
      if (!data) return;

      if (data.type === 'INPUT') {
        // Inject remote Player 2 button input into emulator Controller 2
        if (this.onRemoteInput) {
          this.onRemoteInput(data.button, data.isDown);
        }
      } else if (data.type === 'PING') {
        this.conn.send({ type: 'PONG', time: data.time });
      } else if (data.type === 'PONG') {
        this.ping = Math.round(performance.now() - data.time);
        if (this.onPingUpdate) this.onPingUpdate(this.ping);
      }
    });

    this.conn.on('close', () => {
      this.isConnected = false;
      console.log('Player 2 desconectou.');
      if (this.onStatusChange) {
        this.onStatusChange('Player 2 Desconectou', 'WAITING');
      }
      this._stopPingMonitor();
    });
  }

  joinRoom(targetRoomId) {
    this._cleanup();
    this.mode = 'CLIENT';
    this.roomId = targetRoomId;

    this.peer = new Peer({
      debug: 1
    });

    if (this.onStatusChange) {
      this.onStatusChange('Conectando ao Host...', 'WAITING');
    }

    this.peer.on('open', (myId) => {
      console.log('Client Peer pronto. Conectando a:', targetRoomId);
      this.conn = this.peer.connect(targetRoomId, {
        reliable: false // UDP for minimal latency
      });
      this._setupClientDataConnection();
    });

    // Listen for Host's incoming video/audio stream
    this.peer.on('call', (incomingCall) => {
      console.log('Recebendo transmissão do Host...');
      this.call = incomingCall;
      incomingCall.answer(); // Answer without sending return video

      incomingCall.on('stream', (remoteStream) => {
        console.log('Transmissão de vídeo/áudio recebida!');
        if (this.onRemoteStream) {
          this.onRemoteStream(remoteStream);
        }
      });

      incomingCall.on('error', (e) => console.error('Erro na transmissão:', e));
    });

    this.peer.on('error', (err) => {
      console.error('Erro no PeerJS Client:', err);
      if (this.onStatusChange) {
        this.onStatusChange('Erro ao conectar na sala.', 'OFFLINE');
      }
    });
  }

  _setupClientDataConnection() {
    this.conn.on('open', () => {
      this.isConnected = true;
      console.log('Conectado ao Host com sucesso!');
      if (this.onStatusChange) {
        this.onStatusChange('Conectado ao Host (Player 2)', 'ONLINE');
      }
      this._startPingMonitor();
    });

    this.conn.on('data', (data) => {
      if (!data) return;

      if (data.type === 'ASPECT_RATIO') {
        this.currentRatio = data.ratio;
        if (this.onAspectRatioChange) this.onAspectRatioChange(data.ratio);
      } else if (data.type === 'PING') {
        this.conn.send({ type: 'PONG', time: data.time });
      } else if (data.type === 'PONG') {
        this.ping = Math.round(performance.now() - data.time);
        if (this.onPingUpdate) this.onPingUpdate(this.ping);
      }
    });

    this.conn.on('close', () => {
      this.isConnected = false;
      console.log('Conexão com Host encerrada.');
      if (this.onStatusChange) {
        this.onStatusChange('Desconectado do Host', 'OFFLINE');
      }
      this._stopPingMonitor();
    });
  }

  sendAspectRatio(ratio) {
    this.currentRatio = ratio;
    if (this.isConnected && this.conn && this.conn.open) {
      this.conn.send({
        type: 'ASPECT_RATIO',
        ratio: ratio
      });
    }
  }

  sendInput(buttonName, isDown) {
    if (this.isConnected && this.conn && this.conn.open) {
      this.conn.send({
        type: 'INPUT',
        button: buttonName,
        isDown: isDown
      });
    }
  }

  _startPingMonitor() {
    this._stopPingMonitor();
    this.pingInterval = setInterval(() => {
      if (this.isConnected && this.conn && this.conn.open) {
        this.conn.send({ type: 'PING', time: performance.now() });
      }
    }, 1000);
  }

  _stopPingMonitor() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  getShareableLink() {
    if (!this.roomId) return '';
    const base = window.location.origin + window.location.pathname;
    return `${base}#${this.roomId}`;
  }

  /**
   * Optimizes the WebRTC video stream for maximum crispness (maintain-resolution)
   * while capping bitrate to 3.0 Mbps to remain smooth and stable even on modest connections.
   */
  _optimizePeerConnection(pc) {
    if (!pc) return;

    const applyParameters = () => {
      try {
        const senders = pc.getSenders ? pc.getSenders() : [];
        for (const sender of senders) {
          if (sender.track && sender.track.kind === 'video') {
            const params = sender.getParameters ? sender.getParameters() : null;
            if (!params) continue;

            if (!params.encodings || params.encodings.length === 0) {
              params.encodings = [{}];
            }

            for (const encoding of params.encodings) {
              // 3.0 Mbps cap: pristine 60 FPS xBRZ quality without overloading modest internet connections
              encoding.maxBitrate = 3000000;
              encoding.networkPriority = 'high';
              encoding.maxFramerate = 60;
            }

            // Strictly maintain resolution so HUD and pixel-art contours never get blurry
            if ('degradationPreference' in params) {
              params.degradationPreference = 'maintain-resolution';
            }

            sender.setParameters(params).then(() => {
              console.log('⚡ WebRTC otimizado: 3.0 Mbps max, 60 FPS, maintain-resolution');
            }).catch(() => {
              // Can fail silently during active renegotiation
            });
          }
        }
      } catch (err) {
        console.warn('Configuração WebRTC:', err);
      }
    };

    // Apply immediately and retry after ICE connection stabilizes
    applyParameters();
    setTimeout(applyParameters, 800);
    setTimeout(applyParameters, 2500);

    if (pc.addEventListener) {
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'connected') {
          applyParameters();
        }
      });
    }
  }

  _cleanup() {
    this._stopPingMonitor();
    if (this.conn) {
      try { this.conn.close(); } catch (_) {}
      this.conn = null;
    }
    if (this.call) {
      try { this.call.close(); } catch (_) {}
      this.call = null;
    }
    if (this.peer) {
      try { this.peer.destroy(); } catch (_) {}
      this.peer = null;
    }
    this.isConnected = false;
    this.mode = 'OFFLINE';
  }
}
