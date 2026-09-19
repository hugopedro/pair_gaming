/**
 * js/app.js - Master Orchestrator for Duplinha NES
 * Coordinates UI, Emulator, Inputs, and P2P Networking.
 */

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('nesCanvas');
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

  // Audio helper
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

  // Aspect Ratio System (4:3 CRT TV, 16:10 Wide Suave, 16:9 Total, 8:7 Original)
  const aspectRatios = {
    '4-3': '4:3 (TV CRT)',
    '16-10': '16:10 (Wide Suave)',
    '16-9': '16:9 (Total)',
    'original': '8:7 (Original)'
  };
  let currentRatio = localStorage.getItem('duplinha_ratio') || '4-3';

  function updateAspectRatioUI(ratio, shouldBroadcast = true) {
    currentRatio = ratio;
    localStorage.setItem('duplinha_ratio', ratio);
    const label = document.getElementById('aspectRatioLabel');
    if (label) label.textContent = aspectRatios[ratio] || '4:3 (TV CRT)';
    document.body.classList.remove('ratio-4-3', 'ratio-16-10', 'ratio-16-9', 'ratio-original');
    document.body.classList.add(`ratio-${ratio}`);
    if (shouldBroadcast && typeof multiplayer !== 'undefined' && multiplayer && multiplayer.mode === 'HOST') {
      multiplayer.sendAspectRatio(ratio);
    }
  }

  // 1. Initialize Emulator
  const emulator = new NesEmulator(canvas);
  updateAspectRatioUI(currentRatio, false);
  emulator.onStatusChange = (msg) => showToast(msg);
  emulator.onFPSUpdate = (fps) => {
    const fpsElem = document.getElementById('fpsBadge');
    if (fpsElem) fpsElem.textContent = `${fps} FPS`;
  };

  // 2. Initialize Multiplayer
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

    // Enter fullscreen on first user interaction (browser gesture requirement)
    window.addEventListener('click', triggerFullscreen, { once: true });
    window.addEventListener('keydown', triggerFullscreen, { once: true });
    window.addEventListener('pointerdown', triggerFullscreen, { once: true });

    // Double click to toggle fullscreen anytime
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
      showToast('Transmissão ao vivo recebida!');
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
      if (multiplayer.mode === 'CLIENT' || isPlayer2Mode) {
        // Attempt fullscreen on gamepad/controller button press
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
  function loadRomFromArrayBuffer(buffer, name) {
    ensureAudio();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i += 8192) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, len)));
    }
    const success = emulator.loadROM(binary, name);
    if (success) {
      const romLabel = document.getElementById('currentRomLabel');
      if (romLabel) romLabel.textContent = name;
      showToast(`🎮 ${name} carregado!`);
    }
  }

  // File Picker
  romInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => loadRomFromArrayBuffer(ev.target.result, file.name.replace(/\.nes$/i, ''));
      reader.readAsArrayBuffer(file);
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
    if (file && file.name.toLowerCase().endsWith('.nes')) {
      const reader = new FileReader();
      reader.onload = (ev) => loadRomFromArrayBuffer(ev.target.result, file.name.replace(/\.nes$/i, ''));
      reader.readAsArrayBuffer(file);
    } else {
      showToast('Por favor, solte um arquivo .nes válido!');
    }
  });

  // Built-in Demo ROM button
  const loadPongBtn = document.getElementById('loadPongBtn');
  if (loadPongBtn) {
    loadPongBtn.addEventListener('click', () => {
      fetch('roms/pong.nes')
        .then(res => {
          if (!res.ok) throw new Error('ROM não encontrada');
          return res.arrayBuffer();
        })
        .then(buffer => loadRomFromArrayBuffer(buffer, 'Pong (2 Players)'))
        .catch(err => {
          console.error(err);
          showToast('Erro ao carregar Pong embutido.');
        });
    });
  }

  // 5. Navbar and Controls Buttons
  document.getElementById('btnLoadRom').addEventListener('click', () => romInput.click());

  document.getElementById('btnMultiplayer').addEventListener('click', () => {
    openModal(multiplayerModal);
  });

  document.getElementById('btnControls').addEventListener('click', () => {
    openModal(controlsModal);
  });

  // Graphic Filter Toggle (HD Suave / Scale2x / Pixel Art)
  const btnFilter = document.getElementById('btnFilter');
  const filterLabel = document.getElementById('filterLabel');
  const filterNames = {
    smooth: 'HD Suave ✨',
    scale2x: 'HQ Scale2x 🎮',
    pixelated: 'Pixel Art 👾'
  };

  const updateFilterUI = (mode) => {
    if (filterLabel) filterLabel.textContent = filterNames[mode] || 'HD Suave ✨';
    const cabinet = document.querySelector('.screen-cabinet') || document.body;
    cabinet.classList.remove('filter-smooth', 'filter-scale2x', 'filter-pixelated');
    cabinet.classList.add(`filter-${mode}`);
  };

  updateFilterUI(emulator.filterMode);

  if (btnFilter) {
    btnFilter.addEventListener('click', () => {
      const order = ['smooth', 'scale2x', 'pixelated'];
      const nextIdx = (order.indexOf(emulator.filterMode) + 1) % order.length;
      const nextMode = order[nextIdx];
      emulator.setFilter(nextMode);
      updateFilterUI(nextMode);
      showToast(`Filtro Visual: ${filterNames[nextMode]}`);
    });
  }

  // Aspect Ratio Button Listener
  const btnAspectRatio = document.getElementById('btnAspectRatio');
  if (btnAspectRatio) {
    btnAspectRatio.addEventListener('click', () => {
      const order = ['4-3', '16-10', '16-9', 'original'];
      const nextIdx = (order.indexOf(currentRatio) + 1) % order.length;
      const nextRatio = order[nextIdx];
      updateAspectRatioUI(nextRatio, true);
      showToast(`Proporção de Tela: ${aspectRatios[nextRatio]}`);
    });
  }

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
    showToast('🔄 ROM Reiniciada');
  });

  document.getElementById('btnSaveState').addEventListener('click', () => {
    const saved = emulator.saveState();
    showToast(saved ? '💾 Estado Salvo com Sucesso!' : 'Falha ao salvar estado.');
  });

  document.getElementById('btnLoadState').addEventListener('click', () => {
    const loaded = emulator.loadState();
    showToast(loaded ? '📂 Estado Carregado!' : 'Nenhum estado salvo encontrado.');
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
  volumeSlider.addEventListener('input', (e) => {
    emulator.setVolume(parseFloat(e.target.value));
  });

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
      showToast('Digite o ID ou cole o link da sala!');
      return;
    }
    const targetId = inputVal.includes('#') ? inputVal.split('#')[1] : inputVal;
    setupPlayer2Mode();
    multiplayer.joinRoom(targetId);
    closeModal(multiplayerModal);
  });

  // 7. Modal Open/Close Utilities
  function openModal(modal) {
    modal.classList.add('open');
  }

  function closeModal(modal) {
    modal.classList.remove('open');
  }

  document.querySelectorAll('.modal-close, .modal-backdrop').forEach((elem) => {
    elem.addEventListener('click', (e) => {
      if (e.target === elem) {
        elem.closest('.modal-backdrop').classList.remove('open');
      }
    });
  });

  // 8. Toast Helper
  function showToast(msg, duration = 2500) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = msg;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, duration);
  }

  // 9. Auto-connect if URL contains hash (#duplinha-xyz)
  if (window.location.hash && window.location.hash.length > 1) {
    const roomIdFromHash = window.location.hash.substring(1);
    console.log('Link com sala detectado:', roomIdFromHash);
    setupPlayer2Mode();
    showToast(`Conectando à sala: ${roomIdFromHash}...`);
    multiplayer.joinRoom(roomIdFromHash);
  } else {
    // Automatically load built-in Pong so the screen is ready to play immediately!
    fetch('roms/pong.nes')
      .then(res => res.arrayBuffer())
      .then(buffer => loadRomFromArrayBuffer(buffer, 'Pong (2 Players)'))
      .catch(() => {});
  }
});
