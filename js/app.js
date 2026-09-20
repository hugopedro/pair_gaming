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

  // Aspect Ratio System (SuperWide 16:9, 4:3 CRT TV, 16:10 Wide Suave, 16:9 Total, 8:7 Original)
  const aspectRatios = {
    'superwide': 'SuperWide 🌟 (16:9 Inteligente)',
    '4-3': '4:3 (TV CRT)',
    '16-10': '16:10 (Wide Suave)',
    '16-9': '16:9 (Total)',
    'original': '8:7 (Original)'
  };
  let currentRatio = localStorage.getItem('duplinha_ratio') || 'superwide';

  function updateAspectRatioUI(ratio, shouldBroadcast = true) {
    currentRatio = ratio;
    localStorage.setItem('duplinha_ratio', ratio);
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

  let remoteControlsP1 = false;
  let coPilotActive = false;

  function triggerRewind(seconds = 3) {
    const success = emulator.rewind(seconds);
    if (success) {
      if (typeof input !== 'undefined' && input && input.vibrate) input.vibrate('soft');
      showToast(`⏪ Rebobinado ${seconds}s no tempo!`);
    } else {
      showToast('⚠️ Sem histórico suficiente para rebobinar ainda.');
    }
  }

  function updateCoPilotUI() {
    const copilotBtns = document.querySelectorAll('.btn-copilot');
    const hostBanner = document.getElementById('copilotHostBanner');
    copilotBtns.forEach(btn => {
      if (coPilotActive) {
        btn.classList.add('active');
        const lbl = btn.querySelector('.copilot-label');
        if (lbl) lbl.textContent = 'Co-Pilot: ATIVO 🤝';
      } else {
        btn.classList.remove('active');
        const lbl = btn.querySelector('.copilot-label');
        if (lbl) lbl.textContent = 'Passa o Controle';
      }
    });
    if (hostBanner) {
      hostBanner.style.display = coPilotActive ? 'flex' : 'none';
    }
  }

  function toggleCoPilot() {
    coPilotActive = !coPilotActive;
    updateCoPilotUI();
    if (typeof input !== 'undefined' && input && input.vibrate) input.vibrate('pulse');
    if (multiplayer && multiplayer.mode === 'HOST') {
      multiplayer.sendCopilotStatus(coPilotActive);
    }
    if (coPilotActive) {
      showToast('🤝 Modo Co-Pilot Ativo: Você assumiu o controle do boneco dela!');
    } else {
      showToast('🎮 Modo Co-Pilot Desativado: Controle devolvido para ela.');
    }
  }

  const multiplayer = new MultiplayerManager({
    onRemoteInput: (btn, isDown) => {
      // Host receives Client input -> If Co-Pilot is active, ignore remote inputs so girlfriend does not fight movements
      if (coPilotActive) return;

      const targetPlayer = remoteControlsP1 ? 1 : 2;
      if (isDown) emulator.buttonDown(targetPlayer, btn);
      else emulator.buttonUp(targetPlayer, btn);
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
  multiplayer.onCopilotChange = (active) => {
    const clientBanner = document.getElementById('copilotClientBanner');
    if (clientBanner) {
      clientBanner.style.display = active ? 'flex' : 'none';
    }
    if (active) {
      showToast('🤝 Seu amigo assumiu o controle para te ajudar! Aguarde um instante...', 4000);
    } else {
      showToast('🎮 O controle voltou para você! Boa sorte!', 3000);
    }
  };

  // Initialize In-Game Overlay Chat
  const inGameChat = new InGameChat({
    cabinet: document.querySelector('.screen-cabinet'),
    multiplayer: multiplayer,
    getLocalSenderName: () => (isPlayer2Mode || multiplayer.mode === 'CLIENT' ? 'Namorada' : 'Hugo'),
    getRemoteDefaultName: () => (isPlayer2Mode || multiplayer.mode === 'CLIENT' ? 'Hugo' : 'Namorada')
  });
  window.inGameChat = inGameChat;

  multiplayer.onChatMessage = (sender, text) => {
    inGameChat.addMessage({
      sender: sender || (multiplayer.mode === 'CLIENT' ? 'Hugo' : 'Namorada'),
      text: text,
      isMine: false
    });
    if (typeof input !== 'undefined' && input && input.vibrate) {
      input.vibrate('soft');
    }
  };

  // 3. Initialize Input System
  const input = new InputManager(
    (playerNum, buttonName, isDown) => {
      ensureAudio();

      // Quick Save State (LB) and Quick Load State (RB), REWIND (L3 / Backspace), COPILOT (R3 / C) for Player 1
      if (playerNum === 1) {
        if (buttonName === 'SAVE_STATE') {
          if (isDown) {
            Promise.resolve(emulator.saveState()).then(saved => {
              showToast(saved ? '💾 Estado Salvo com Sucesso! (LB)' : 'Falha ao salvar estado.');
            });
          }
          return;
        }
        if (buttonName === 'LOAD_STATE') {
          if (isDown) {
            Promise.resolve(emulator.loadState()).then(loaded => {
              showToast(loaded ? '📂 Estado Carregado! (RB)' : 'Nenhum estado salvo encontrado.');
            });
          }
          return;
        }
        if (buttonName === 'REWIND') {
          if (isDown) {
            triggerRewind(3);
          }
          return;
        }
        if (buttonName === 'COPILOT') {
          if (isDown) {
            toggleCoPilot();
          }
          return;
        }
      }

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
        // Local or Host:
        let localTarget = remoteControlsP1 ? (playerNum === 1 ? 2 : 1) : playerNum;
        // In Co-Pilot mode, Host inputs (Player 1) control her player directly
        if (coPilotActive && playerNum === 1) {
          localTarget = remoteControlsP1 ? 1 : 2;
        }
        if (isDown) emulator.buttonDown(localTarget, buttonName);
        else emulator.buttonUp(localTarget, buttonName);
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

  // Initialize Reactions & Soundboard
  const reactions = new ReactionsManager({
    cabinet: document.querySelector('.screen-cabinet'),
    multiplayer: multiplayer,
    inputManager: input,
    getLocalSenderName: () => (isPlayer2Mode || multiplayer.mode === 'CLIENT' ? 'Namorada' : 'Hugo')
  });
  window.reactions = reactions;

  multiplayer.onReaction = (reactionId, sender) => {
    reactions.trigger(reactionId, false, sender || (multiplayer.mode === 'CLIENT' ? 'Hugo' : 'Namorada'));
  };

  // Initialize Clip Recorder (10s rolling buffer)
  const clipRecorder = new ClipRecorder({
    canvas: canvas,
    video: remoteVideo,
    onStatusChange: (msg) => showToast(msg)
  });
  window.clipRecorder = clipRecorder;

  // 4. ROM Loading Helper
  function loadRomFromArrayBuffer(buffer, name) {
    ensureAudio();
    const bytes = new Uint8Array(buffer);

    // Detect compressed archives disguised as ROMs
    if (bytes.length >= 4) {
      if (bytes[0] === 0x37 && bytes[1] === 0x7A && bytes[2] === 0xBC && bytes[3] === 0xAF) {
        showToast(`⚠️ "${name}" está compactado em 7-Zip (.7z). Por favor, use a ROM descompactada (.nes)!`, 5000);
        return;
      }
      if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
        showToast(`⚠️ "${name}" está compactado em ZIP (.zip). Extraia a ROM (.nes) antes de jogar!`, 5000);
        return;
      }
      if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) {
        showToast(`⚠️ "${name}" está compactado em RAR (.rar). Extraia a ROM (.nes) antes de jogar!`, 5000);
        return;
      }
    }

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

  // Aspect Ratio Button Listener
  const btnAspectRatio = document.getElementById('btnAspectRatio');
  if (btnAspectRatio) {
    btnAspectRatio.addEventListener('click', () => {
      const order = ['superwide', '4-3', '16-10', '16-9', 'original'];
      const nextIdx = (order.indexOf(currentRatio) + 1) % order.length;
      const nextRatio = order[nextIdx];
      updateAspectRatioUI(nextRatio, true);
      showToast(`Proporção de Tela: ${aspectRatios[nextRatio]}`);
    });
  }

  // Overscan Crop Button Listener
  const btnCrop = document.getElementById('btnCrop');
  const cropLabel = document.getElementById('cropLabel');
  const updateCropUI = (isCropped) => {
    if (cropLabel) cropLabel.textContent = isCropped ? 'Bordas: Cortadas ✨' : 'Bordas: Originais ⬛';
  };
  updateCropUI(emulator.cropOverscan);
  if (btnCrop) {
    btnCrop.addEventListener('click', () => {
      const isCropped = emulator.toggleCropOverscan();
      updateCropUI(isCropped);
      showToast(isCropped ? '✂️ Bordas Pretas Cortadas (Tela Cheia 100%)' : '⬛ Bordas Pretas Originais Ativadas');
    });
  }

  // Video Filter Button Listener (xBRZ 6x vs Pixel Art Nítido)
  const filterLabels = {
    'xbrz': 'Filtro: xBRZ 6x ✨',
    'crisp': 'Filtro: Pixel Art 👾'
  };
  const btnFilter = document.getElementById('btnFilter');
  const filterLabel = document.getElementById('filterLabel');
  const updateFilterUI = (filter) => {
    if (filterLabel) filterLabel.textContent = filterLabels[filter] || 'Filtro: xBRZ 6x ✨';
  };
  updateFilterUI(emulator.videoFilter);
  if (btnFilter) {
    btnFilter.addEventListener('click', () => {
      const nextFilter = emulator.toggleVideoFilter();
      updateFilterUI(nextFilter);
      showToast(nextFilter === 'crisp' ? '👾 Modo Pixel Art Nítido (Zero Flickering / 60 FPS)' : '✨ Modo xBRZ 6x HD Ativado');
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

  document.getElementById('btnSaveState').addEventListener('click', async () => {
    const saved = await emulator.saveState();
    showToast(saved ? '💾 Estado Salvo com Sucesso!' : 'Falha ao salvar estado.');
  });

  document.getElementById('btnLoadState').addEventListener('click', async () => {
    const loaded = await emulator.loadState();
    showToast(loaded ? '📂 Estado Carregado!' : 'Nenhum estado salvo encontrado.');
  });

  // Rewind & Co-Pilot Click Listeners (Top and Bottom bars)
  document.querySelectorAll('.btn-rewind').forEach(btn => {
    btn.addEventListener('click', () => triggerRewind(3));
  });

  document.querySelectorAll('.btn-copilot').forEach(btn => {
    btn.addEventListener('click', () => toggleCoPilot());
  });

  function updatePlayerRolesUI() {
    const swapBtns = document.querySelectorAll('.btn-swap-p1p2');
    const swapLabels = document.querySelectorAll('.swap-label, #swapLabel');
    const swapIcons = document.querySelectorAll('.swap-icon, #swapIcon');
    const p1Device = document.getElementById('p1Device');
    const p2Device = document.getElementById('p2Device');

    if (remoteControlsP1) {
      swapBtns.forEach(btn => btn.classList.add('active'));
      swapLabels.forEach(lbl => lbl.textContent = 'Ela controla: P1 👑');
      swapIcons.forEach(icn => icn.textContent = '👑');
      if (p1Device) p1Device.textContent = '👩 Namorada (P1)';
      if (p2Device) p2Device.textContent = '🎮 Você (Host / P2)';
    } else {
      swapBtns.forEach(btn => btn.classList.remove('active'));
      swapLabels.forEach(lbl => lbl.textContent = 'Ela controla: P2 🎮');
      swapIcons.forEach(icn => icn.textContent = '🎮');
      if (p1Device) p1Device.textContent = '🎮 Você (Host / P1)';
      if (p2Device) p2Device.textContent = '👩 Namorada (P2)';
    }
  }

  document.querySelectorAll('.btn-swap-p1p2').forEach(btn => {
    btn.addEventListener('click', () => {
      remoteControlsP1 = !remoteControlsP1;
      updatePlayerRolesUI();
      showToast(remoteControlsP1 
        ? '👑 Namorada agora controla o Player 1! (Você comanda o P2)' 
        : '🎮 Modo Normal: Você comanda o Player 1 e ela o Player 2');
    });
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
  const customRoomInput = document.getElementById('customRoomInput');
  const savedCustomRoom = localStorage.getItem('duplinha_custom_room');
  if (customRoomInput && savedCustomRoom) {
    customRoomInput.value = savedCustomRoom;
  }

  document.getElementById('btnCreateRoom').addEventListener('click', () => {
    const customRoom = customRoomInput ? customRoomInput.value.trim() : '';
    if (customRoom) {
      localStorage.setItem('duplinha_custom_room', customRoom);
    }
    multiplayer.createRoom(() => emulator.getMediaStream(), customRoom);
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

  // 10. Retro Context Menu with Picture-in-Picture & Copy Image
  let pipVideo = null;

  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        return;
      }

      if (isPlayer2Mode && remoteVideo) {
        if (remoteVideo.readyState >= 2) {
          await remoteVideo.requestPictureInPicture();
          showToast('📺 Picture-in-Picture Ativado!');
        } else {
          showToast('⚠️ Aguarde a transmissão iniciar para abrir PiP.');
        }
        return;
      }

      if (!pipVideo) {
        pipVideo = document.createElement('video');
        pipVideo.muted = true;
        pipVideo.playsInline = true;
        pipVideo.style.position = 'fixed';
        pipVideo.style.top = '-9999px';
        pipVideo.style.left = '-9999px';
        pipVideo.style.width = '1px';
        pipVideo.style.height = '1px';
        pipVideo.style.opacity = '0';
        pipVideo.style.pointerEvents = 'none';
        document.body.appendChild(pipVideo);
      }

      const stream = canvas.captureStream ? canvas.captureStream(60) : null;
      if (!stream) {
        showToast('⚠️ Picture-in-Picture não suportado neste navegador.');
        return;
      }
      pipVideo.srcObject = stream;
      await pipVideo.play();
      await pipVideo.requestPictureInPicture();
      showToast('📺 Picture-in-Picture Ativado!');
    } catch (err) {
      console.warn('Erro ao abrir Picture-in-Picture:', err);
      showToast('⚠️ Não foi possível abrir Picture-in-Picture.');
    }
  }

  async function copyImageToClipboard() {
    try {
      if (isPlayer2Mode && remoteVideo) {
        const tmpCanvas = document.createElement('canvas');
        tmpCanvas.width = remoteVideo.videoWidth || 1280;
        tmpCanvas.height = remoteVideo.videoHeight || 720;
        const tmpCtx = tmpCanvas.getContext('2d');
        tmpCtx.drawImage(remoteVideo, 0, 0, tmpCanvas.width, tmpCanvas.height);
        tmpCanvas.toBlob(async (blob) => {
          if (!blob) return;
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
            showToast('📋 Screenshot copiada para a área de transferência!');
          } catch (_) {
            showToast('⚠️ Permissão negada para copiar imagem.');
          }
        });
        return;
      }

      canvas.toBlob(async (blob) => {
        if (!blob) {
          showToast('⚠️ Não foi possível capturar a imagem.');
          return;
        }
        try {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
          showToast('📋 Screenshot copiada para a área de transferência!');
        } catch (_) {
          showToast('⚠️ Permissão negada para copiar imagem.');
        }
      });
    } catch (err) {
      console.warn('Erro ao copiar imagem:', err);
      showToast('⚠️ Erro ao copiar imagem.');
    }
  }

  const cabinet = document.querySelector('.screen-cabinet');
  let contextMenu = document.getElementById('retroContextMenu');
  if (!contextMenu) {
    contextMenu = document.createElement('div');
    contextMenu.id = 'retroContextMenu';
    contextMenu.className = 'retro-context-menu';
    contextMenu.style.display = 'none';
    contextMenu.innerHTML = `
      <div class="retro-context-menu-item" id="menuItemPip">
        <span class="menu-icon">📺</span>
        <span>Picture-in-Picture</span>
      </div>
      <div class="retro-context-menu-item" id="menuItemCopy">
        <span class="menu-icon">📋</span>
        <span>Copiar Imagem</span>
      </div>
      <div class="retro-context-menu-divider"></div>
      <div class="retro-context-menu-item" id="menuItemFullscreen">
        <span class="menu-icon">⛶</span>
        <span>Tela Cheia</span>
      </div>
    `;
    document.body.appendChild(contextMenu);

    contextMenu.querySelector('#menuItemPip').addEventListener('click', () => {
      closeContextMenu();
      togglePictureInPicture();
    });

    contextMenu.querySelector('#menuItemCopy').addEventListener('click', () => {
      closeContextMenu();
      copyImageToClipboard();
    });

    contextMenu.querySelector('#menuItemFullscreen').addEventListener('click', () => {
      closeContextMenu();
      if (!document.fullscreenElement) {
        if (cabinet.requestFullscreen) cabinet.requestFullscreen();
        else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
      } else {
        if (document.exitFullscreen) document.exitFullscreen();
      }
    });
  }

  function closeContextMenu() {
    if (contextMenu) contextMenu.style.display = 'none';
  }

  window.addEventListener('click', () => closeContextMenu());
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') closeContextMenu();
  });

  if (cabinet) {
    cabinet.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const menuWidth = 230;
      const menuHeight = 130;
      let x = e.clientX;
      let y = e.clientY;

      if (x + menuWidth > window.innerWidth) {
        x = window.innerWidth - menuWidth - 8;
      }
      if (y + menuHeight > window.innerHeight) {
        y = window.innerHeight - menuHeight - 8;
      }

      contextMenu.style.left = `${Math.max(8, x)}px`;
      contextMenu.style.top = `${Math.max(8, y)}px`;
      contextMenu.style.display = 'flex';
    });
  }
});
