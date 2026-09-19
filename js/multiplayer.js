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
    this.onCopilotChange = null;            // (active) => {}
    this.onChatMessage = null;              // (sender, text) => {}
    this.onReaction = null;                 // (reactionId, sender) => {}
    this.currentRatio = '4-3';
    this.autoReconnect = true;
    this.reconnectAttempts = 0;
    this.getLocalMediaStream = null;
  }

  createRoom(getLocalMediaStream, customRoomId = '') {
    this._cleanup();
    this.mode = 'HOST';
    this.getLocalMediaStream = getLocalMediaStream;

    let targetId = '';
    if (customRoomId && customRoomId.trim()) {
      targetId = customRoomId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
      if (!targetId.startsWith('duplinha-')) {
        targetId = `duplinha-${targetId}`;
      }
    } else {
      const randomSuffix = Math.random().toString(36).substring(2, 7);
      targetId = `duplinha-${randomSuffix}`;
    }

    this.peer = new Peer(targetId, {
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
      this._setupHostDataConnection(this.getLocalMediaStream);
    });

    this.peer.on('error', (err) => {
      console.error('Erro no PeerJS Host:', err);
      if (err.type === 'unavailable-id') {
        const fallbackId = `${targetId}-${Math.random().toString(36).substring(2, 6)}`;
        console.warn(`ID de sala '${targetId}' ocupado. Tentando ID único: ${fallbackId}...`);
        this.createRoom(getLocalMediaStream, fallbackId);
        return;
      }
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
      } else if (data.type === 'CHAT') {
        if (this.onChatMessage) {
          this.onChatMessage(data.sender, data.text);
        }
      } else if (data.type === 'REACTION') {
        if (this.onReaction) {
          this.onReaction(data.reactionId, data.sender);
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
      this._optimizePeerConnection(incomingCall.peerConnection);
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
      this.reconnectAttempts = 0;
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
      } else if (data.type === 'COPILOT_STATUS') {
        if (this.onCopilotChange) this.onCopilotChange(data.active);
      } else if (data.type === 'CHAT') {
        if (this.onChatMessage) this.onChatMessage(data.sender, data.text);
      } else if (data.type === 'REACTION') {
        if (this.onReaction) this.onReaction(data.reactionId, data.sender);
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
      this._stopPingMonitor();

      if (this.autoReconnect && this.mode === 'CLIENT' && this.roomId && this.reconnectAttempts < 5) {
        this.reconnectAttempts++;
        if (this.onStatusChange) {
          this.onStatusChange(`Conexão oscilou. Reconectando (${this.reconnectAttempts}/5)...`, 'WAITING');
        }
        setTimeout(() => {
          if (!this.isConnected && this.mode === 'CLIENT') {
            console.log(`Reconectando à sala ${this.roomId}...`);
            this.joinRoom(this.roomId);
          }
        }, 2500);
      } else {
        if (this.onStatusChange) {
          this.onStatusChange('Desconectado do Host', 'OFFLINE');
        }
      }
    });
  }

  sendChatMessage(text, sender = '') {
    if (this.isConnected && this.conn && this.conn.open) {
      this.conn.send({
        type: 'CHAT',
        text: text,
        sender: sender
      });
      return true;
    }
    return false;
  }

  sendReaction(reactionId, sender = '') {
    if (this.isConnected && this.conn && this.conn.open) {
      this.conn.send({
        type: 'REACTION',
        reactionId: reactionId,
        sender: sender
      });
      return true;
    }
    return false;
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

  sendCopilotStatus(active) {
    if (this.isConnected && this.conn && this.conn.open) {
      this.conn.send({
        type: 'COPILOT_STATUS',
        active: active
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
   * Optimizes the WebRTC video stream for minimal latency and bufferbloat immunity:
   *  - Prioritizes GPU-accelerated H.264 codec (NVENC/AMD/Intel QuickSync: ~2ms latency)
   *  - Caps bitrate to 1.8 Mbps (prevents Wi-Fi packet queuing and 293ms ping spikes)
   *  - Uses 'balanced' degradation preference to protect framerate & input response
   */
  _optimizePeerConnection(pc) {
    if (!pc) return;

    // 1. Prioritize H.264 hardware-accelerated codec
    try {
      if ('RTCRtpSender' in window && 'getCapabilities' in RTCRtpSender) {
        const capabilities = RTCRtpSender.getCapabilities('video');
        if (capabilities && capabilities.codecs) {
          const h264 = capabilities.codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
          const others = capabilities.codecs.filter(c => c.mimeType.toLowerCase() !== 'video/h264');
          const preferred = [...h264, ...others];
          const transceivers = pc.getTransceivers ? pc.getTransceivers() : [];
          for (const t of transceivers) {
            if (t.setCodecPreferences) {
              t.setCodecPreferences(preferred);
            }
          }
        }
      }
    } catch (err) {
      console.warn('Prioridade H.264 WebRTC:', err);
    }

    // 2. Configure bitrate and degradation parameters
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
              // 1.8 Mbps cap: pristine 60 FPS 720p 2D graphics without router bufferbloat
              encoding.maxBitrate = 1800000;
              encoding.networkPriority = 'high';
              encoding.maxFramerate = 60;
            }

            // 'balanced' preserves framerate & latency when Wi-Fi fluctuates
            if ('degradationPreference' in params) {
              params.degradationPreference = 'balanced';
            }

            sender.setParameters(params).then(() => {
              console.log('⚡ WebRTC otimizado: 1.8 Mbps max, 60 FPS, balanced, H.264');
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
    setTimeout(applyParameters, 500);
    setTimeout(applyParameters, 2000);

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
