/**
 * js/snes-app.js - Master Orchestrator for Duplinha SNES (Super Nintendo)
 * Coordinates UI, SnesEmulator, Gamepad Inputs, Co-Pilot, and WebRTC Networking.
 */

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('snesCanvas');
  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo) remoteVideo.style.display = 'none';
  const dropZone = document.getElementById('dropZone');
  const romInput = document.getElementById('romInput');
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  const pingText = document.getElementById('pingText');
  const toastContainer = document.getElementById('toastContainer');

  // Modals
  const multiplayerModal = document.getElementById('multiplayerModal');
  const controlsModal = document.getElementById('controlsModal');

  // Aspect Ratio System (16:9 Total Linear, 4:3 CRT TV, 16:10 Wide Suave, SuperWide)
  const aspectRatios = {
    '16-9': '16:9 Total 🌟',
    '4-3': '4:3 CRT 📺',
    '16-10': '16:10 Wide 🖥️',
    'superwide': 'SuperWide 🌟'
  };
  let savedRatio = localStorage.getItem('duplinha_snes_ratio');
  if (!savedRatio || savedRatio === 'superwide') {
    savedRatio = '16-9';
    localStorage.setItem('duplinha_snes_ratio', '16-9');
  }
  let currentRatio = savedRatio;

  function updateAspectRatioUI(ratio, shouldBroadcast = true) {
    currentRatio = ratio;
    localStorage.setItem('duplinha_snes_ratio', ratio);
    const label = document.getElementById('aspectRatioLabel');
    if (label) label.textContent = aspectRatios[ratio] || '16:9 Total 🌟';
    document.body.classList.remove('ratio-superwide', 'ratio-4-3', 'ratio-16-10', 'ratio-16-9', 'ratio-original');
    document.body.classList.add(`ratio-${ratio}`);
    if (typeof emulator !== 'undefined' && emulator) {
      emulator.setAspectRatio(ratio);
    }
    if (shouldBroadcast && typeof multiplayer !== 'undefined' && multiplayer && multiplayer.mode === 'HOST') {
      multiplayer.sendAspectRatio(ratio);
    }
  }

  // 1. Initialize Super Nintendo Emulator
  const emulator = new SnesEmulator(canvas);
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

  let remoteControlsP1 = false;
  let coPilotActive = false;

  async function triggerRewind(seconds = 3) {
    const success = await emulator.rewind(seconds);
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
      if (coPilotActive) return;
      const targetPlayer = remoteControlsP1 ? 1 : 2;
      if (isDown) emulator.buttonDown(targetPlayer, btn);
      else emulator.buttonUp(targetPlayer, btn);
    },
    onRemoteStream: (stream) => {
      setupPlayer2Mode();
      remoteVideo.srcObject = stream;
      remoteVideo.play().catch(e => console.warn('Autoplay video bloqueado:', e));
      showToast('Transmissão ao vivo do Super Nintendo recebida!');
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
      else pingText.style.color = 'var(--neon-red)';
    },
    onAspectRatioReceived: (ratio) => {
      updateAspectRatioUI(ratio, false);
      showToast(`Proporção ajustada pelo Host: ${aspectRatios[ratio] || ratio}`);
    },
    onCopilotChange: (active) => {
      const clientBanner = document.getElementById('copilotClientBanner');
      if (clientBanner) {
        clientBanner.style.display = active ? 'flex' : 'none';
      }
      if (active) {
        showToast('🤝 O Hugo assumiu o controle para te ajudar! Solte o controle um instante.');
      } else {
        showToast('🎮 Controle devolvido para você! Boa sorte, amor!');
      }
    }
  });

  // 3. Initialize Input System with SNES mapping (Xbox LT/RT = L/R, LB/RB = Save/Load)
  const input = new InputManager(
    (playerNum, buttonName, isDown) => {
      // Quick Save State (LB), Quick Load State (RB), REWIND (L3 / Backspace), COPILOT (R3 / C)
      if (playerNum === 1) {
        if (buttonName === 'SAVE_STATE') {
          if (isDown) {
            Promise.resolve(emulator.saveState()).then(res => {
              if (res && res.localSavedName) {
                showToast(`💾 Salvo no PC! (${res.localSavedName})`, 3500);
              } else if (res) {
                showToast('💾 Estado Salvo com Sucesso! (LB)');
              } else {
                showToast('Falha ao salvar estado.');
              }
            });
          }
          return;
        }
        if (buttonName === 'LOAD_STATE') {
          if (isDown) {
            Promise.resolve(emulator.loadState()).then(res => {
              if (res && res.loadedFromLocal) {
                showToast(`📂 Carregado do PC! (${res.loadedFromLocal})`, 3500);
              } else if (res) {
                showToast('📂 Estado Carregado! (RB)');
              } else {
                showToast('Nenhum estado salvo encontrado.');
              }
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
        let localTarget = remoteControlsP1 ? (playerNum === 1 ? 2 : 1) : playerNum;
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
    },
    { system: 'snes' }
  );

  // Initialize Reactions & Soundboard
  const reactions = new ReactionsManager({
    cabinet: document.querySelector('.screen-cabinet'),
    multiplayer: multiplayer,
    inputManager: input,
    getLocalSenderName: () => (isPlayer2Mode || multiplayer.mode === 'CLIENT' ? 'Sandy' : 'Hugo')
  });
  window.reactions = reactions;

  multiplayer.onReaction = (reactionId, sender) => {
    reactions.trigger(reactionId, false, sender || (multiplayer.mode === 'CLIENT' ? 'Hugo' : 'Sandy'));
  };

  // Initialize Clip Recorder (10s rolling buffer)
  const clipRecorder = new ClipRecorder({
    canvas: canvas,
    video: remoteVideo,
    onStatusChange: (msg) => showToast(msg)
  });
  window.clipRecorder = clipRecorder;

  // 4. ROM Loading Helper
  async function loadRomFile(file) {
    const cleanName = file.name.replace(/\.(sfc|smc|zip|bin)$/i, '');

    try {
      const buffer = await file.arrayBuffer();
      const success = await emulator.loadROM(buffer, cleanName, file.name);
      if (success) {
        const romLabel = document.getElementById('currentRomLabel');
        if (romLabel) romLabel.textContent = cleanName;
        showToast(`🎮 ${cleanName} carregado com sucesso!`);
      }
    } catch (e) {
      console.error('Erro lendo arquivo SNES:', e);
      showToast('Erro ao ler arquivo da ROM.');
    }
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
    if (file) {
      loadRomFile(file);
    }
  });

  // UI Button Bindings
  document.getElementById('btnLoadRom').addEventListener('click', () => {
    romInput.click();
  });

  document.getElementById('btnMultiplayer').addEventListener('click', () => {
    openModal(multiplayerModal);
  });

  document.getElementById('btnControls').addEventListener('click', () => {
    openModal(controlsModal);
  });

  const aspectOrder = ['16-9', '4-3', '16-10', 'superwide'];
  document.getElementById('btnAspectRatio').addEventListener('click', () => {
    const nextIdx = (aspectOrder.indexOf(currentRatio) + 1) % aspectOrder.length;
    updateAspectRatioUI(aspectOrder[nextIdx], true);
    showToast(`Proporção de Tela: ${aspectRatios[aspectOrder[nextIdx]]}`);
  });

  // Video Filter System (Suave HD, Pixel Art Nítido, CRT Scanlines)
  const filterLabels = {
    'smooth': 'Filtro: Suave HD ✨',
    'crisp': 'Filtro: Pixel Art 👾',
    'crt': 'Filtro: CRT Scanlines 📺'
  };
  const filterOrder = ['smooth', 'crisp', 'crt'];
  let currentFilter = localStorage.getItem('duplinha_snes_filter') || 'smooth';

  function updateFilterUI(filter) {
    currentFilter = filter;
    localStorage.setItem('duplinha_snes_filter', filter);
    const filterLabel = document.getElementById('filterLabel');
    if (filterLabel) filterLabel.textContent = filterLabels[filter] || 'Filtro: Suave HD ✨';

    const cabinet = document.querySelector('.screen-cabinet');
    if (cabinet) {
      cabinet.classList.remove('filter-crt');
      if (filter === 'crt') cabinet.classList.add('filter-crt');
    }

    const activeCanvas = document.querySelector('.screen-cabinet canvas') || canvas;
    if (activeCanvas) {
      activeCanvas.classList.remove('filter-smooth', 'filter-crisp');
      activeCanvas.classList.add(`filter-${filter === 'crt' ? 'crisp' : filter}`);
    }
    if (remoteVideo) {
      remoteVideo.classList.remove('filter-smooth', 'filter-crisp');
      remoteVideo.classList.add(`filter-${filter === 'crt' ? 'crisp' : filter}`);
    }
  }

  updateFilterUI(currentFilter);

  const btnFilter = document.getElementById('btnFilter');
  if (btnFilter) {
    btnFilter.addEventListener('click', () => {
      const nextIdx = (filterOrder.indexOf(currentFilter) + 1) % filterOrder.length;
      updateFilterUI(filterOrder[nextIdx]);
      showToast(filterLabels[filterOrder[nextIdx]]);
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
    showToast('🔄 Super Nintendo Reiniciado');
  });

  document.getElementById('btnSaveState').addEventListener('click', async () => {
    const res = await emulator.saveState();
    if (res && res.localSavedName) {
      showToast(`💾 Salvo no PC! (${res.localSavedName})`, 3500);
    } else if (res) {
      showToast('💾 Estado Salvo com Sucesso!');
    } else {
      showToast('Falha ao salvar estado.');
    }
  });

  document.getElementById('btnLoadState').addEventListener('click', async () => {
    const res = await emulator.loadState();
    if (res && res.loadedFromLocal) {
      showToast(`📂 Carregado do PC! (${res.loadedFromLocal})`, 3500);
    } else if (res) {
      showToast('📂 Estado Carregado!');
    } else {
      showToast('Nenhum estado salvo encontrado.');
    }
  });

  // Rewind & Co-Pilot Click Listeners
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
      swapLabels.forEach(lbl => lbl.textContent = 'Sandy controla: P1 👑');
      swapIcons.forEach(icn => icn.textContent = '👑');
      if (p1Device) p1Device.textContent = '👩 Sandy (P1)';
      if (p2Device) p2Device.textContent = '🎮 Hugo (Host / P2)';
    } else {
      swapBtns.forEach(btn => btn.classList.remove('active'));
      swapLabels.forEach(lbl => lbl.textContent = 'Sandy controla: P2 🎮');
      swapIcons.forEach(icn => icn.textContent = '🎮');
      if (p1Device) p1Device.textContent = '🎮 Hugo (Host / P1)';
      if (p2Device) p2Device.textContent = '👩 Sandy (P2)';
    }
  }

  document.querySelectorAll('.btn-swap-p1p2').forEach(btn => {
    btn.addEventListener('click', () => {
      remoteControlsP1 = !remoteControlsP1;
      updatePlayerRolesUI();
      showToast(remoteControlsP1 
        ? '👑 Sandy agora controla o Player 1! (Você comanda o P2)' 
        : '🎮 Você assumiu o Player 1! (Sandy comanda o P2)');
    });
  });

  // Clip Button Top / Bottom
  document.querySelectorAll('.btn-clip-save').forEach(btn => {
    btn.addEventListener('click', () => {
      if (clipRecorder) clipRecorder.saveClip();
    });
  });

  // Multiplayer Host / Connect Logic
  document.getElementById('btnStartHost').addEventListener('click', () => {
    multiplayer.startHost(emulator.getMediaStream());
    document.getElementById('hostBox').style.display = 'block';
    document.getElementById('joinBox').style.display = 'none';
  });

  document.getElementById('btnCopyLink').addEventListener('click', () => {
    const inputLink = document.getElementById('inviteLink');
    inputLink.select();
    navigator.clipboard.writeText(inputLink.value);
    showToast('📋 Link copiado! Envie para a Sandy pelo WhatsApp!');
  });

  document.getElementById('btnConnectClient').addEventListener('click', () => {
    const code = document.getElementById('joinCodeInput').value.trim();
    if (code) {
      multiplayer.connectToHost(code);
      closeModal(multiplayerModal);
    } else {
      showToast('Por favor, insira o código de convite.');
    }
  });

  // Auto-connect if ?room= query param exists
  const urlParams = new URLSearchParams(window.location.search);
  const roomId = urlParams.get('room');
  if (roomId) {
    showToast('Conectando ao Super Nintendo do Hugo...');
    multiplayer.connectToHost(roomId);
  }

  // Modal Helpers
  function openModal(modal) {
    if (!modal) return;
    modal.classList.add('active');
  }

  function closeModal(modal) {
    if (!modal) return;
    modal.classList.remove('active');
  }

  document.querySelectorAll('.modal-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const modal = e.target.closest('.modal-overlay');
      closeModal(modal);
    });
  });

  window.addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-overlay')) {
      closeModal(e.target);
    }
  });

  // Toast Notification System
  function showToast(message, duration = 3000) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  }

  // Initialize In-Game Chat System
  const chat = new ChatManager({
    multiplayer: multiplayer,
    getLocalSenderName: () => (isPlayer2Mode || multiplayer.mode === 'CLIENT' ? 'Sandy' : 'Hugo'),
    onNewMessage: (sender, text) => {
      showToast(`💬 ${sender}: ${text}`, 4000);
    }
  });
  window.inGameChat = chat;

  // Retro Context Menu (Right Click on Cabinet)
  let pipVideo = null;
  async function togglePictureInPicture() {
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
        showToast('📺 Picture-in-Picture fechado.');
        return;
      }
      if (isPlayer2Mode && remoteVideo && remoteVideo.srcObject) {
        if (remoteVideo.requestPictureInPicture) {
          await remoteVideo.requestPictureInPicture();
          showToast('📺 Picture-in-Picture ativo!');
          return;
        }
      }
      if (!pipVideo) {
        pipVideo = document.createElement('video');
        pipVideo.muted = true;
        pipVideo.playsInline = true;
        pipVideo.style.position = 'fixed';
        pipVideo.style.top = '-9999px';
        pipVideo.style.left = '-9999px';
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
      if (pipVideo.requestPictureInPicture) {
        await pipVideo.requestPictureInPicture();
        showToast('📺 Picture-in-Picture ativo!');
      } else {
        showToast('⚠️ Picture-in-Picture não suportado.');
      }
    } catch (err) {
      console.warn('Erro ao abrir Picture-in-Picture:', err);
      showToast('⚠️ Não foi possível abrir o Picture-in-Picture.');
    }
  }

  async function copyImageToClipboard() {
    try {
      if (isPlayer2Mode && remoteVideo && remoteVideo.videoWidth) {
        const offCanvas = document.createElement('canvas');
        offCanvas.width = remoteVideo.videoWidth || 640;
        offCanvas.height = remoteVideo.videoHeight || 480;
        const offCtx = offCanvas.getContext('2d');
        offCtx.drawImage(remoteVideo, 0, 0, offCanvas.width, offCanvas.height);
        offCanvas.toBlob(async (blob) => {
          if (!blob) {
            showToast('⚠️ Não foi possível capturar o frame do vídeo.');
            return;
          }
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
      <div class="retro-context-menu-item" id="menuItemSavesFolder">
        <span class="menu-icon">📁</span>
        <span>Pasta de Saves no PC</span>
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

    contextMenu.querySelector('#menuItemSavesFolder').addEventListener('click', async () => {
      closeContextMenu();
      const res = await emulator.selectSavesDirectory();
      if (res && res.success) {
        showToast(`📁 Pasta de saves vinculada: ${res.name}`, 4000);
      } else if (res && res.reason === 'unsupported') {
        showToast('⚠️ Navegador não suporta acesso a pastas locais.');
      } else if (res && res.reason !== 'aborted') {
        showToast('⚠️ Não foi possível vincular a pasta.');
      }
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
      const menuHeight = 180;
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
