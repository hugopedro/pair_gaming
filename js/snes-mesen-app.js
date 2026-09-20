/**
 * js/snes-mesen-app.js - Controller for Mesen Stream & WebRTC Co-op
 */

(function() {
  const urlParams = new URLSearchParams(window.location.search);
  const isClient = urlParams.get('role') === 'client';
  const targetRoom = urlParams.get('room');

  const videoElement = document.getElementById('mesenVideo');
  const overlay = document.getElementById('mesenOverlay');
  const btnStartCapture = document.getElementById('btnStartCapture');
  const btnStartCaptureHero = document.getElementById('btnStartCaptureHero');
  const btnMultiplayer = document.getElementById('btnMultiplayer');
  const btnFullscreen = document.getElementById('btnFullscreen');
  const modal = document.getElementById('multiplayerModal');
  const btnCloseModal = document.getElementById('btnCloseModal');
  const inviteLinkInput = document.getElementById('inviteLinkInput');
  const btnCopyInviteLink = document.getElementById('btnCopyInviteLink');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const pingText = document.getElementById('pingText');
  const bridgePill = document.getElementById('bridgePill');
  const bridgeText = document.getElementById('bridgeText');

  let localStream = null;
  let bridgeSocket = null;
  let bridgeConnected = false;

  function showToast(msg) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3500);
  }

  // === LOCAL BRIDGE WEBSOCKET (Forward Sandy's inputs to Mesen on Windows) ===
  function initBridge() {
    if (isClient) return; // Only host connects to local bridge

    try {
      bridgeSocket = new WebSocket('ws://localhost:8088');

      bridgeSocket.onopen = () => {
        bridgeConnected = true;
        if (bridgePill) {
          bridgePill.classList.remove('disconnected');
          bridgePill.classList.add('connected');
        }
        if (bridgeText) bridgeText.textContent = 'Bridge P2: Ativa 🟢';
        showToast('🔌 Bridge do Mesen conectada no seu PC!');
      };

      bridgeSocket.onclose = () => {
        bridgeConnected = false;
        if (bridgePill) {
          bridgePill.classList.remove('connected');
          bridgePill.classList.add('disconnected');
        }
        if (bridgeText) bridgeText.textContent = 'Bridge P2: Desconectada';
        setTimeout(initBridge, 3000);
      };

      bridgeSocket.onerror = () => {
        bridgeConnected = false;
      };
    } catch (_) {
      bridgeConnected = false;
    }
  }

  function forwardInputToBridge(button, isDown) {
    if (bridgeSocket && bridgeSocket.readyState === WebSocket.OPEN) {
      bridgeSocket.send(JSON.stringify({ button, isDown, player: 2 }));
    }
  }

  // === MULTIPLAYER MANAGER ===
  const multiplayer = new MultiplayerManager({
    onRemoteInput: (button, isDown) => {
      // Host receives Player 2 button from Sandy
      forwardInputToBridge(button, isDown);
    },
    onRemoteStream: (stream) => {
      // Client receives Mesen stream from Hugo
      videoElement.srcObject = stream;
      videoElement.play().catch(e => console.warn('Autoplay error:', e));
      if (overlay) overlay.style.display = 'none';
      showToast('🎮 Transmissão do Mesen recebida em 60 FPS!');
    },
    onStatusChange: (status, mode) => {
      if (statusText) statusText.textContent = status;
      if (statusDot) {
        statusDot.className = 'status-dot';
        if (mode === 'ONLINE') statusDot.classList.add('online');
        else if (mode === 'WAITING') statusDot.classList.add('waiting');
        else statusDot.classList.add('offline');
      }
    },
    onPingUpdate: (ping) => {
      if (pingText) {
        pingText.textContent = `${ping}ms`;
        if (ping < 50) pingText.style.color = '#00e676';
        else if (ping < 120) pingText.style.color = '#ffcc00';
        else pingText.style.color = '#ff3366';
      }
    }
  });

  // === HOST STREAM CAPTURE (Mesen Window) ===
  async function startCapture() {
    try {
      localStream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'window',
          frameRate: { ideal: 60, max: 60 }
        },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 2
        }
      });

      videoElement.srcObject = localStream;
      videoElement.play();

      if (overlay) overlay.style.display = 'none';
      if (btnStartCapture) {
        btnStartCapture.classList.add('active');
        btnStartCapture.innerHTML = '<span>🔴</span> <span>Mesen Ativo</span>';
      }

      showToast('✅ Janela do Mesen capturada! Agora convide a Sandy.');

      // Automatically create room if not created yet
      if (!multiplayer.roomId) {
        multiplayer.createRoom(() => localStream);
      }

      localStream.getVideoTracks()[0].onended = () => {
        showToast('Transmissão encerrada.');
        if (overlay) overlay.style.display = 'flex';
        if (btnStartCapture) {
          btnStartCapture.classList.remove('active');
          btnStartCapture.innerHTML = '<span>🖥️</span> <span>Compartilhar Mesen</span>';
        }
      };
    } catch (err) {
      console.error('Erro ao capturar janela do Mesen:', err);
      showToast('Erro ao capturar: ' + (err.message || 'Cancelado'));
    }
  }

  // === CONTROLS INPUT LISTENER (FOR SANDY AS CLIENT) ===
  const KEY_TO_SNES = {
    'ArrowUp': 'BUTTON_UP',
    'ArrowDown': 'BUTTON_DOWN',
    'ArrowLeft': 'BUTTON_LEFT',
    'ArrowRight': 'BUTTON_RIGHT',
    'KeyW': 'BUTTON_UP',
    'KeyS': 'BUTTON_DOWN',
    'KeyA': 'BUTTON_LEFT',
    'KeyD': 'BUTTON_RIGHT',
    'KeyK': 'BUTTON_B',
    'KeyL': 'BUTTON_A',
    'KeyI': 'BUTTON_X',
    'KeyJ': 'BUTTON_Y',
    'KeyU': 'BUTTON_L',
    'KeyO': 'BUTTON_R',
    'Enter': 'BUTTON_START',
    'ShiftRight': 'BUTTON_SELECT',
    'Space': 'BUTTON_SELECT'
  };

  const activeKeys = new Set();

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const button = KEY_TO_SNES[e.code];
    if (button && !activeKeys.has(button)) {
      activeKeys.add(button);
      if (isClient) {
        multiplayer.sendInput(button, true);
      } else {
        // Host playing locally
        forwardInputToBridge(button, true);
      }
    }
  });

  window.addEventListener('keyup', (e) => {
    const button = KEY_TO_SNES[e.code];
    if (button) {
      activeKeys.delete(button);
      if (isClient) {
        multiplayer.sendInput(button, false);
      } else {
        forwardInputToBridge(button, false);
      }
    }
  });

  // Gamepad Polling (for Player 2 controller)
  let gamepadPollId = null;
  const prevButtonsState = {};

  function pollGamepad() {
    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of gamepads) {
      if (!gp) continue;

      // Standard Gamepad mapping
      const mapping = [
        { idx: 0, name: 'BUTTON_B' },       // Xbox A -> SNES B
        { idx: 1, name: 'BUTTON_A' },       // Xbox B -> SNES A
        { idx: 2, name: 'BUTTON_Y' },       // Xbox X -> SNES Y
        { idx: 3, name: 'BUTTON_X' },       // Xbox Y -> SNES X
        { idx: 4, name: 'BUTTON_L' },       // LB
        { idx: 5, name: 'BUTTON_R' },       // RB
        { idx: 8, name: 'BUTTON_SELECT' },  // Back / Select
        { idx: 9, name: 'BUTTON_START' },   // Start
        { idx: 12, name: 'BUTTON_UP' },     // D-Pad Up
        { idx: 13, name: 'BUTTON_DOWN' },   // D-Pad Down
        { idx: 14, name: 'BUTTON_LEFT' },   // D-Pad Left
        { idx: 15, name: 'BUTTON_RIGHT' },  // D-Pad Right
      ];

      for (const item of mapping) {
        const btn = gp.buttons[item.idx];
        const isPressed = btn ? (btn.pressed || btn.value > 0.5) : false;
        const wasPressed = !!prevButtonsState[item.name];

        if (isPressed !== wasPressed) {
          prevButtonsState[item.name] = isPressed;
          if (isClient) {
            multiplayer.sendInput(item.name, isPressed);
          } else {
            forwardInputToBridge(item.name, isPressed);
          }
        }
      }
      break; // Use first connected gamepad
    }
    gamepadPollId = requestAnimationFrame(pollGamepad);
  }
  requestAnimationFrame(pollGamepad);

  // === INITIALIZATION ===
  if (isClient && targetRoom) {
    // Client mode (Sandy)
    if (overlay) overlay.style.display = 'none';
    if (btnStartCapture) btnStartCapture.style.display = 'none';
    if (btnMultiplayer) btnMultiplayer.style.display = 'none';
    if (bridgePill) bridgePill.style.display = 'none';

    showToast('Conectando ao Mesen do Hugo...');
    multiplayer.joinRoom(targetRoom);
  } else {
    // Host mode (Hugo)
    initBridge();

    if (btnStartCapture) btnStartCapture.addEventListener('click', startCapture);
    if (btnStartCaptureHero) btnStartCaptureHero.addEventListener('click', startCapture);

    if (btnMultiplayer) {
      btnMultiplayer.addEventListener('click', () => {
        if (!multiplayer.roomId) {
          multiplayer.createRoom(() => localStream);
        }
        const baseUrl = window.location.href.split('?')[0];
        const inviteUrl = `${baseUrl}?role=client&room=${multiplayer.roomId}`;
        if (inviteLinkInput) inviteLinkInput.value = inviteUrl;
        if (modal) modal.style.display = 'flex';
      });
    }

    if (bridgePill) {
      bridgePill.addEventListener('click', () => {
        showToast(bridgeConnected 
          ? '🟢 Bridge ativa! Os comandos da Sandy vão direto para o Mesen.' 
          : '⚠️ Para ativar a Bridge, abra o arquivo iniciar_mesen_bridge.bat no seu PC!');
      });
    }
  }

  if (btnCloseModal && modal) {
    btnCloseModal.addEventListener('click', () => modal.style.display = 'none');
  }

  if (btnCopyInviteLink && inviteLinkInput) {
    btnCopyInviteLink.addEventListener('click', () => {
      inviteLinkInput.select();
      navigator.clipboard.writeText(inviteLinkInput.value);
      showToast('📋 Link copiado! Envie para a Sandy.');
    });
  }

  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      const cabinet = document.querySelector('.screen-cabinet');
      if (!document.fullscreenElement) {
        cabinet.requestFullscreen().catch(e => console.warn(e));
      } else {
        document.exitFullscreen().catch(e => console.warn(e));
      }
    });
  }

})();
