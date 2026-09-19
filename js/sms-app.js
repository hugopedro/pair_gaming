/**
 * js/sms-app.js - Master Orchestrator for Duplinha Master (Sega Master System)
 * Coordinates UI, SMS Emulator, Gamepad Inputs, and P2P Networking.
 */

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('smsCanvas');
  const remoteVideo = document.getElementById('remoteVideo');
  const dropZone = document.getElementById('dropZone');
  const romInput = document.getElementById('romInput');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const pingText = document.getElementById('pingText');
  const toastContainer = document.getElementById('toastContainer');

  // Modals
  const multiplayerModal = document.getElementById('multiplayerModal');
  const controlsModal = document.getElementById('controlsModal');

  // Audio gesture helper
  let userInteracted = false;
  const ensureAudio = () => {
    if (!userInteracted) {
      userInteracted = true;
      if (emulator.audioCtx && emulator.audioCtx.state === 'suspended') {
        emulator.audioCtx.resume();
      }
    }
  };
  window.addEventListener('click', ensureAudio, { once: true });
  window.addEventListener('keydown', ensureAudio, { once: true });

  // Aspect Ratio System (SuperWide 16:9, 4:3 CRT TV, 16:10 Wide Suave, 16:9 Total)
  const aspectRatios = {
    'superwide': 'SuperWide 🌟 (16:9 Inteligente)',
    '4-3': '4:3 (TV CRT)',
    '16-10': '16:10 (Wide Suave)',
    '16-9': '16:9 (Total)',
    'original': '4:3 (Original SMS)'
  };
  let currentRatio = localStorage.getItem('duplinha_sms_ratio') || 'superwide';

  function updateAspectRatioUI(ratio, shouldBroadcast = true) {
    currentRatio = ratio;
    localStorage.setItem('duplinha_sms_ratio', ratio);
    const label = document.getElementById('aspectRatioLabel');
    if (label) label.textContent = aspectRatios[ratio] || 'SuperWide 🌟 (16:9 Inteligente)';
    document.body.classList.remove('ratio-superwide', 'ratio-4-3', 'ratio-16-10', 'ratio-16-9', 'ratio-original');
    document.body.classList.add(`ratio-${ratio}`);
    if (typeof emulator !== 'undefined' && emulator) {
      emulator.setAspectRatio(ratio);
    }
    if (shouldBroadcast && typeof multiplayer !== 'undefined' && multiplayer && multiplayer.mode === 'HOST') {
      multiplayer.sendAspectRatio(ratio);
    }
  }

  // 1. Initialize Master System Emulator
  const emulator = new SmsEmulator(canvas);
  updateAspectRatioUI(currentRatio, false);
  emulator.onStatusChange = (msg) => showToast(msg);
  emulator.onFPSUpdate = (fps) => {
    const fpsElem = document.getElementById('fpsBadge');
    if (fpsElem) fpsElem.textContent = `${fps} FPS`;
  };

  // 2. Initialize Multiplayer (WebRTC P2P)
  let isPlayer2Mode = false;
  function setupPlayer2Mode() {
    if (isPlayer2Mode) return;
    isPlayer2Mode = true;

    document.body.classList.add('player2-mode');
    canvas.style.display = 'none';
    remoteVideo.style.display = 'block';

    // Close any open modals
    if (multiplayerModal) closeModal(multiplayerModal);
    if (controlsModal) closeModal(controlsModal);

    // Fullscreen trigger helper
    const triggerFullscreen = () => {
      if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
        document.documentElement.requestFullscreen().catch(() => {});
      }
      dismissHint();
    };

    // Create subtle hint overlay for Player 2
    let hint = document.querySelector('.p2-hint-overlay');
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'p2-hint-overlay';
      hint.innerHTML = '<span>🎮</span> <span>Player 2 Conectada • Clique ou aperte qualquer botão para Tela Cheia</span>';
      document.body.appendChild(hint);
    }

    const dismissHint = () => {
      if (hint) {
        hint.classList.add('fade-out');
        setTimeout(() => {
          if (hint && hint.parentNode) hint.remove();
        }, 800);
      }
    };

    setTimeout(dismissHint, 6000);

    window.addEventListener('click', triggerFullscreen, { once: true });
    window.addEventListener('keydown', triggerFullscreen, { once: true });
    window.addEventListener('pointerdown', triggerFullscreen, { once: true });

    window.addEventListener('dblclick', () => {
      if (!document.fullscreenElement) {
        if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    });
  }

  const multiplayer = new MultiplayerManager({
    onRemoteInput: (btn, isDown) => {
      // Host receives Client input -> inject into Controller 2
      if (isDown) emulator.buttonDown(2, btn);
      else emulator.buttonUp(2, btn);
    },
    onRemoteStream: (stream) => {
      // Client receives Host's AV stream -> display on remoteVideo in fullscreen
      setupPlayer2Mode();
      remoteVideo.srcObject = stream;
      remoteVideo.play().catch(e => console.warn('Autoplay video bloqueado:', e));
      showToast('Transmissão ao vivo do Master System recebida!');
    },
    onStatusChange: (text, mode) => {
      statusText.textContent = text;
      statusDot.className = 'status-dot';
      if (mode === 'ONLINE') statusDot.classList.add('online');
      else if (mode === 'WAITING') statusDot.classList.add('waiting');
      else statusDot.classList.add('offline');
    },
    onPingUpdate: (ping) => {
      pingText.textContent = `${ping}ms`;
      if (ping < 60) pingText.style.color = 'var(--neon-green)';
      else if (ping < 120) pingText.style.color = 'var(--neon-yellow)';
      else pingText.style.color = 'var(--neon-pink)';
    }
  });

  multiplayer.onAspectRatioChange = (ratio) => updateAspectRatioUI(ratio, false);

  // 3. Initialize Input System
  const input = new InputManager(
    (playerNum, buttonName, isDown) => {
      ensureAudio();

      // Quick Save State (LB) and Quick Load State (RB) for Player 1
      if (playerNum === 1) {
        if (buttonName === 'SAVE_STATE') {
          if (isDown) {
            emulator.saveState().then(saved => {
              showToast(saved ? '💾 Estado Salvo com Sucesso! (LB)' : 'Falha ao salvar estado.');
            });
          }
          return;
        }
        if (buttonName === 'LOAD_STATE') {
          if (isDown) {
            emulator.loadState().then(loaded => {
              showToast(loaded ? '📂 Estado Carregado! (RB)' : 'Nenhum estado salvo encontrado.');
            });
          }
          return;
        }
      }

      if (multiplayer.mode === 'CLIENT' || isPlayer2Mode) {
        if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
          document.documentElement.requestFullscreen().catch(() => {});
          const hint = document.querySelector('.p2-hint-overlay');
          if (hint) {
            hint.classList.add('fade-out');
            setTimeout(() => { if (hint && hint.parentNode) hint.remove(); }, 800);
          }
        }
        multiplayer.sendInput(buttonName, isDown);
      } else {
        if (isDown) emulator.buttonDown(playerNum, buttonName);
        else emulator.buttonUp(playerNum, buttonName);
      }
    },
    (playerNum, gamepadId, isConnected) => {
      const label = isConnected ? '🎮 Xbox 360' : '⚠️ Desconectado';
      const devElem = document.getElementById(playerNum === 1 ? 'p1Device' : 'p2Device');
      if (devElem) devElem.textContent = label;
      showToast(isConnected
        ? `🎮 Controle Xbox 360 conectado (P${playerNum}): ${gamepadId}`
        : `⚠️ Controle P${playerNum} desconectado!`
      );
    }
  );

  // 4. ROM Loading Helper
  function loadRomFile(file) {
    ensureAudio();
    const cleanName = file.name.replace(/\.(sms|bin)$/i, '');
    emulator.loadROM(file, cleanName).then(success => {
      if (success) {
        const romLabel = document.getElementById('currentRomLabel');
        if (romLabel) romLabel.textContent = cleanName;
        showToast(`🎮 ${cleanName} carregado com sucesso!`);
      }
    });
  }

  // File Picker
  romInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      loadRomFile(file);
    }
  });

  // Drag and Drop
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('active');
  });

  window.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) {
      dropZone.classList.remove('active');
    }
  });

  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('active');
    const file = e.dataTransfer.files[0];
    if (file && (file.name.toLowerCase().endsWith('.sms') || file.name.toLowerCase().endsWith('.bin'))) {
      loadRomFile(file);
    } else {
      showToast('Por favor, solte um arquivo de Master System (.sms ou .bin) válido!');
    }
  });

  // 5. Navbar and Controls Buttons
  document.getElementById('btnLoadRom').addEventListener('click', () => romInput.click());

  document.getElementById('btnMultiplayer').addEventListener('click', () => {
    openModal(multiplayerModal);
  });

  document.getElementById('btnControls').addEventListener('click', () => {
    openModal(controlsModal);
  });

  const aspectOrder = ['superwide', '4-3', '16-10', '16-9', 'original'];
  document.getElementById('btnAspectRatio').addEventListener('click', () => {
    const nextIdx = (aspectOrder.indexOf(currentRatio) + 1) % aspectOrder.length;
    updateAspectRatioUI(aspectOrder[nextIdx], true);
    showToast(`Proporção de Tela: ${aspectRatios[aspectOrder[nextIdx]]}`);
  });

  document.getElementById('btnFullscreen').addEventListener('click', () => {
    const cabinet = document.querySelector('.screen-cabinet');
    if (!document.fullscreenElement) {
      if (cabinet.requestFullscreen) cabinet.requestFullscreen();
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
    }
  });

  document.getElementById('btnPause').addEventListener('click', () => {
    const isPaused = emulator.togglePause();
    showToast(isPaused ? '⏸️ PAUSADO' : '▶️ CONTINUANDO');
  });

  document.getElementById('btnReset').addEventListener('click', () => {
    emulator.reloadROM();
    showToast('🔄 Master System Reiniciado');
  });

  document.getElementById('btnSaveState').addEventListener('click', () => {
    emulator.saveState().then(saved => {
      showToast(saved ? '💾 Estado Salvo com Sucesso! (LB)' : 'Falha ao salvar estado.');
    });
  });

  document.getElementById('btnLoadState').addEventListener('click', () => {
    emulator.loadState().then(loaded => {
      showToast(loaded ? '📂 Estado Carregado! (RB)' : 'Nenhum estado salvo encontrado.');
    });
  });

  document.getElementById('btnSwapP1P2').addEventListener('click', () => {
    const isSwapped = input.toggleSwapRoles();
    showToast(`Controles Invertidos: Você agora é ${isSwapped ? 'Player 2' : 'Player 1'}`);
    const swapBtn = document.getElementById('btnSwapP1P2');
    if (swapBtn) swapBtn.textContent = isSwapped ? 'Inverter (P2)' : 'Inverter (P1)';
  });

  document.getElementById('btnTouchToggle').addEventListener('click', () => {
    const touchControls = document.getElementById('touchControls');
    if (touchControls) touchControls.classList.toggle('active');
  });

  // Volume slider
  const volumeSlider = document.getElementById('volumeSlider');
  if (volumeSlider) {
    volumeSlider.addEventListener('input', (e) => {
      emulator.setVolume(parseFloat(e.target.value));
    });
  }

  // 6. Multiplayer Modal Actions
  document.getElementById('btnCreateRoom').addEventListener('click', () => {
    multiplayer.createRoom(() => emulator.getMediaStream());
    const interval = setInterval(() => {
      if (multiplayer.roomId) {
        clearInterval(interval);
        const link = multiplayer.getShareableLink();
        document.getElementById('shareLinkText').textContent = link;
        document.getElementById('shareLinkBox').style.display = 'flex';
      }
    }, 200);
  });

  document.getElementById('btnCopyLink').addEventListener('click', () => {
    const link = multiplayer.getShareableLink();
    if (link) {
      navigator.clipboard.writeText(link).then(() => {
        showToast('📋 Link da Sala Copiado!');
      });
    }
  });

  document.getElementById('btnJoinRoom').addEventListener('click', () => {
    const inputVal = document.getElementById('joinRoomInput').value.trim();
    if (!inputVal) {
      showToast('Por favor, digite o ID ou Link da sala!');
      return;
    }
    const roomId = inputVal.includes('#') ? inputVal.split('#')[1] : inputVal;
    multiplayer.joinRoom(roomId);
    closeModal(multiplayerModal);
  });

  // Auto-connect if URL has #room-id
  const hash = window.location.hash.substring(1);
  if (hash && hash.startsWith('duplinha-')) {
    console.log('Detectado link de convite Master System:', hash);
    setTimeout(() => {
      multiplayer.joinRoom(hash);
      showToast(`Conectando à sala ${hash}...`);
    }, 500);
  }

  // Modal helpers
  function openModal(modal) {
    if (modal) modal.classList.add('active');
  }

  function closeModal(modal) {
    if (modal) modal.classList.remove('active');
  }

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-backdrop');
      closeModal(modal);
    });
  });

  document.querySelectorAll('.modal-backdrop').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal);
    });
  });

  // Toast Helper
  function showToast(message, duration = 3000) {
    if (!toastContainer) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.classList.add('fade-out');
      setTimeout(() => toast.remove(), 400);
    }, duration);
  }
});
