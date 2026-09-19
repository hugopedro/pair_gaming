/**
 * js/sms-app.js - Master Orchestrator for Duplinha Master (Sega Master System)
 * Coordinates UI, SMS Emulator, Gamepad Inputs, and P2P Networking.
 */

document.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('smsCanvas');
  const remoteVideo = document.getElementById('remoteVideo');
  if (remoteVideo) remoteVideo.style.display = 'none';
  localStorage.removeItem('duplinha_sms_crop_overscan');
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

  // Aspect Ratio System (16:9 Total Linear, 4:3 CRT TV, 16:10 Wide Suave, SuperWide)
  const aspectRatios = {
    '16-9': '16:9 Total 🌟',
    '4-3': '4:3 CRT 📺',
    '16-10': '16:10 Wide 🖥️',
    'superwide': 'SuperWide 🌟'
  };
  let savedRatio = localStorage.getItem('duplinha_sms_ratio');
  if (!savedRatio || savedRatio === 'superwide') {
    savedRatio = '16-9';
    localStorage.setItem('duplinha_sms_ratio', '16-9');
  }
  let currentRatio = savedRatio;

  function updateAspectRatioUI(ratio, shouldBroadcast = true) {
    currentRatio = ratio;
    localStorage.setItem('duplinha_sms_ratio', ratio);
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

  let remoteControlsP1 = false;
  let coPilotActive = false;

  function triggerRewind(seconds = 3) {
    const success = emulator.rewind(seconds);
    if (success) {
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

  // 3. Initialize Input System
  const input = new InputManager(
    (playerNum, buttonName, isDown) => {
      ensureAudio();

      // Quick Save State (LB), Quick Load State (RB), REWIND (L3 / Backspace), COPILOT (R3 / C) for Player 1
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
        // Local or Host:
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
    }
  );

  // 4. ROM Loading Helper
  async function loadRomFile(file) {
    ensureAudio();
    const cleanName = file.name.replace(/\.(sms|bin)$/i, '');

    try {
      const buffer = await file.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      // Detect compressed archives disguised as ROMs
      if (bytes.length >= 4) {
        if (bytes[0] === 0x37 && bytes[1] === 0x7A && bytes[2] === 0xBC && bytes[3] === 0xAF) {
          showToast(`⚠️ "${file.name}" é um arquivo 7-Zip (.7z). Por favor, use a ROM descompactada (.sms)!`, 6000);
          return;
        }
        if (bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04) {
          showToast(`⚠️ "${file.name}" está compactado em ZIP (.zip). Extraia a ROM (.sms) antes de jogar!`, 6000);
          return;
        }
        if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) {
          showToast(`⚠️ "${file.name}" está compactado em RAR (.rar). Extraia a ROM (.sms) antes de jogar!`, 6000);
          return;
        }
      }

      emulator.loadROM(buffer, cleanName).then(success => {
        if (success) {
          const romLabel = document.getElementById('currentRomLabel');
          if (romLabel) romLabel.textContent = cleanName;
          showToast(`🎮 ${cleanName} carregado com sucesso!`);
        }
      });
    } catch (e) {
      console.error('Erro lendo arquivo:', e);
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

  const aspectOrder = ['16-9', '4-3', '16-10', 'superwide'];
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
