/**
 * js/chat.js - In-Game Overlay Chat for Duplinha (NES & Master System)
 * Displays auto-fading translucent chat messages and an on-demand input bar
 * directly inside the screen cabinet, working seamlessly in windowed and fullscreen.
 */

class InGameChat {
  constructor({ cabinet, multiplayer, getLocalSenderName, getRemoteDefaultName }) {
    this.cabinet = cabinet || document.querySelector('.screen-cabinet');
    this.multiplayer = multiplayer;
    this.getLocalSenderName = getLocalSenderName || (() => 'Você');
    this.getRemoteDefaultName = getRemoteDefaultName || (() => 'Player 2');
    this.isOpen = false;
    this.unreadCount = 0;
    this.audioCtx = null;

    this._createDOM();
    this._bindEvents();
  }

  _createDOM() {
    // If chat container already exists in DOM, reuse it
    let container = document.getElementById('ingameChat');
    if (!container) {
      container = document.createElement('div');
      container.className = 'ingame-chat';
      container.id = 'ingameChat';
      container.innerHTML = `
        <div class="chat-messages" id="chatMessages"></div>
        <form class="chat-input-wrap" id="chatInputWrap" style="display: none;">
          <input type="text" id="chatInput" class="chat-input" placeholder="Conversar... (Enter envia, Esc fecha)" maxlength="120" autocomplete="off" />
          <button type="submit" class="chat-send-btn" id="chatSendBtn" title="Enviar mensagem">➤</button>
        </form>
        <button type="button" class="chat-toggle-btn" id="chatToggleBtn" title="Abrir Chat (Atalho: Enter ou T)">
          <span>💬</span>
          <span class="chat-toggle-label">Chat</span>
          <span class="chat-unread-badge" id="chatUnreadBadge" style="display: none;">0</span>
        </button>
      `;
      this.cabinet.appendChild(container);
    }

    this.container = container;
    this.messagesContainer = container.querySelector('#chatMessages');
    this.inputWrap = container.querySelector('#chatInputWrap');
    this.inputElem = container.querySelector('#chatInput');
    this.sendBtn = container.querySelector('#chatSendBtn');
    this.toggleBtn = container.querySelector('#chatToggleBtn');
    this.unreadBadge = container.querySelector('#chatUnreadBadge');
  }

  _bindEvents() {
    // Submit form -> send message
    this.inputWrap.addEventListener('submit', (e) => {
      e.preventDefault();
      this.sendMessage();
    });

    // Toggle button click
    this.toggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (this.isOpen) {
        this.closeInput();
      } else {
        this.openInput();
      }
    });

    // Input blur handling (when clicking outside)
    this.inputElem.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeInput();
      }
    });

    // Global keyboard shortcut to open chat (Enter or T)
    window.addEventListener('keydown', (e) => {
      // Do nothing if any modal is currently open
      if (document.querySelector('.modal-backdrop.open')) {
        return;
      }

      // If chat input is already open, let the input element handle typing/Enter/Escape
      if (this.isOpen) {
        return;
      }

      // If user is focused on another input or textarea, ignore
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        return;
      }

      // 'Enter' or 'KeyT' triggers chat open
      if (e.code === 'Enter' || e.code === 'KeyT') {
        e.preventDefault();
        this.openInput();
      }
    });

    // Prevent clicks inside chat from propagating and stealing game focus unintentionally
    this.container.addEventListener('click', (e) => {
      e.stopPropagation();
    });
  }

  openInput() {
    this.isOpen = true;
    this.inputWrap.style.display = 'flex';
    this.container.classList.add('active');
    this.unreadCount = 0;
    this._updateUnreadBadge();

    // Focus input
    setTimeout(() => {
      this.inputElem.focus();
    }, 50);
  }

  closeInput() {
    this.isOpen = false;
    this.inputWrap.style.display = 'none';
    this.container.classList.remove('active');
    this.inputElem.value = '';
    this.inputElem.blur();

    // Return focus to the cabinet/window for gameplay
    if (this.cabinet && this.cabinet.focus) {
      this.cabinet.focus();
    }
  }

  sendMessage() {
    const text = (this.inputElem.value || '').trim();
    if (!text) {
      this.closeInput();
      return;
    }

    const localSender = this.getLocalSenderName ? this.getLocalSenderName() : 'Você';

    // Send via WebRTC DataChannel
    let sent = false;
    if (this.multiplayer) {
      sent = this.multiplayer.sendChatMessage(text, localSender);
    }

    // Display locally
    this.addMessage({
      sender: 'Você',
      text: text,
      isMine: true
    });

    // If not connected, give a subtle hint
    if (!sent && (!this.multiplayer || !this.multiplayer.isConnected)) {
      this.addMessage({
        sender: 'Sistema',
        text: '⚠️ Conecte-se online (Jogar Online P2P) para que seu amigo receba suas mensagens.',
        isSystem: true
      });
    }

    this.closeInput();
  }

  addMessage({ sender, text, isMine = false, isSystem = false }) {
    const msgElem = document.createElement('div');
    const roleClass = isSystem ? 'system' : (isMine ? 'host' : 'client');
    msgElem.className = `chat-msg ${roleClass}`;

    const senderSpan = document.createElement('span');
    senderSpan.className = 'chat-sender';
    senderSpan.textContent = isSystem ? '⚙️ Sistema:' : `${sender || this.getRemoteDefaultName()}:`;

    const textSpan = document.createElement('span');
    textSpan.className = 'chat-text';
    textSpan.textContent = text;

    msgElem.appendChild(senderSpan);
    msgElem.appendChild(textSpan);

    this.messagesContainer.appendChild(msgElem);
    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

    // Play subtle notification sound if incoming message
    if (!isMine && !isSystem) {
      this._playNotificationSound();
      if (!this.isOpen) {
        this.unreadCount++;
        this._updateUnreadBadge();
      }
    }

    // Auto-fadeout after 6.5s
    setTimeout(() => {
      msgElem.classList.add('faded');
      // Cleanup after 30s so DOM doesn't grow indefinitely
      setTimeout(() => {
        if (msgElem.parentNode && msgElem.classList.contains('faded')) {
          msgElem.remove();
        }
      }, 30000);
    }, 6500);

    // Keep max 30 messages in DOM
    while (this.messagesContainer.children.length > 30) {
      this.messagesContainer.removeChild(this.messagesContainer.firstChild);
    }
  }

  _updateUnreadBadge() {
    if (this.unreadCount > 0) {
      this.unreadBadge.textContent = this.unreadCount;
      this.unreadBadge.style.display = 'inline-block';
      this.toggleBtn.classList.add('has-unread');
    } else {
      this.unreadBadge.style.display = 'none';
      this.toggleBtn.classList.remove('has-unread');
    }
  }

  _playNotificationSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      if (!this.audioCtx) {
        this.audioCtx = new AudioCtx();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.type = 'sine';
      // Retro chime: C6 (1046Hz) -> E6 (1318Hz)
      osc.frequency.setValueAtTime(1046.5, now);
      osc.frequency.setValueAtTime(1318.5, now + 0.05);

      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      osc.start(now);
      osc.stop(now + 0.15);
    } catch (_) {
      // Audio autoplay policy can fail silently
    }
  }
}
