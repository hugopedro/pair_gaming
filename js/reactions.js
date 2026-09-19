/**
 * js/reactions.js - Quick Reactions & 8-Bit Retro Soundboard for Duplinha
 * Allows players to send real-time floating emojis and synthesized 8-bit sound effects
 * without taking their hands off the controller/gameplay.
 */

class ReactionsManager {
  constructor({ cabinet, multiplayer, inputManager, getLocalSenderName }) {
    this.cabinet = cabinet || document.querySelector('.screen-cabinet');
    this.multiplayer = multiplayer;
    this.input = inputManager;
    this.getLocalSenderName = getLocalSenderName || (() => 'Você');
    this.audioCtx = null;

    this.reactions = {
      love: { id: 'love', emoji: '❤️', label: 'Amor', key: '1', rumble: 'heartbeat', sound: '1up' },
      laugh: { id: 'laugh', emoji: '😂', label: 'Risada', key: '2', rumble: 'pulse', sound: 'boing' },
      alert: { id: 'alert', emoji: '😱', label: 'Cuidado!', key: '3', rumble: 'strong', sound: 'alarm' },
      victory: { id: 'victory', emoji: '👏', label: 'Boa!', key: '4', rumble: 'medium', sound: 'fanfare' },
      oops: { id: 'oops', emoji: '💀', label: 'Ops!', key: '5', rumble: 'soft', sound: 'sad' }
    };

    this._createDOM();
    this._bindEvents();
  }

  _createDOM() {
    // Overlay removed as requested - reactions are triggered via keys 1-5 outside chat
    const bar = document.getElementById('reactionsBar');
    if (bar) {
      bar.remove();
    }
  }

  _bindEvents() {
    const keyMap = {
      'Digit1': 'love', 'Numpad1': 'love', '1': 'love',
      'Digit2': 'laugh', 'Numpad2': 'laugh', '2': 'laugh',
      'Digit3': 'alert', 'Numpad3': 'alert', '3': 'alert',
      'Digit4': 'victory', 'Numpad4': 'victory', '4': 'victory',
      'Digit5': 'oops', 'Numpad5': 'oops', '5': 'oops'
    };

    // Keyboard shortcuts (1-5) when NOT typing in input or chat
    window.addEventListener('keydown', (e) => {
      // Ignore if modals are open
      if (document.querySelector('.modal-backdrop.open, .modal-backdrop.active')) return;
      // Ignore if in-game chat is open
      if (window.inGameChat && window.inGameChat.isOpen) return;
      // Ignore if user is typing in any input or editable field
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable)) return;

      const reactionId = keyMap[e.code] || keyMap[e.key];
      if (reactionId) {
        e.preventDefault();
        this.trigger(reactionId, true);
      }
    });
  }

  trigger(reactionId, isLocal = true, senderName = '') {
    const reaction = this.reactions[reactionId];
    if (!reaction) return;

    const sender = isLocal ? (this.getLocalSenderName ? this.getLocalSenderName() : 'Você') : senderName;

    // 1. Play synthesized 8-bit sound
    this._playSound(reaction.sound);

    // 2. Trigger Xbox controller vibration
    if (this.input && typeof this.input.vibrate === 'function') {
      this.input.vibrate(reaction.rumble);
    }

    // 3. Render visual floating particle explosion on screen
    this._spawnFloatingEmojis(reaction.emoji, sender);

    // 4. If local, broadcast via WebRTC DataChannel
    if (isLocal && this.multiplayer) {
      this.multiplayer.sendReaction(reactionId, sender);
    }
  }

  _spawnFloatingEmojis(emoji, sender) {
    const container = document.createElement('div');
    container.className = 'reaction-burst-container';

    // Badge showing who reacted
    const banner = document.createElement('div');
    banner.className = 'reaction-banner';
    banner.innerHTML = `<span class="rb-emoji">${emoji}</span> <span class="rb-sender">${sender}</span>`;
    container.appendChild(banner);

    // Spawn 6 floating particles
    for (let i = 0; i < 6; i++) {
      const particle = document.createElement('div');
      particle.className = 'reaction-particle';
      particle.textContent = emoji;

      // Random trajectories
      const xOffset = (Math.random() - 0.5) * 160;
      const yOffset = -80 - Math.random() * 120;
      const rot = (Math.random() - 0.5) * 60;
      const delay = Math.random() * 0.15;
      const scale = 0.8 + Math.random() * 0.7;

      particle.style.setProperty('--dx', `${xOffset}px`);
      particle.style.setProperty('--dy', `${yOffset}px`);
      particle.style.setProperty('--rot', `${rot}deg`);
      particle.style.setProperty('--scale', scale);
      particle.style.animationDelay = `${delay}s`;

      container.appendChild(particle);
    }

    this.cabinet.appendChild(container);

    // Remove from DOM after animation finishes
    setTimeout(() => {
      if (container.parentNode) container.remove();
    }, 2200);
  }

  _playSound(soundType) {
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

      if (soundType === '1up') {
        // Classic 8-bit rising 1-Up arpeggio
        const notes = [330, 392, 659, 523, 587, 784];
        notes.forEach((freq, idx) => {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.type = 'square';
          osc.frequency.setValueAtTime(freq, now + idx * 0.055);
          gain.gain.setValueAtTime(0.06, now + idx * 0.055);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.055 + 0.08);
          osc.connect(gain);
          gain.connect(this.audioCtx.destination);
          osc.start(now + idx * 0.055);
          osc.stop(now + idx * 0.055 + 0.08);
        });
      } else if (soundType === 'boing') {
        // Whimsical boing / laughing slide
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(220, now);
        osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
        osc.frequency.exponentialRampToValueAtTime(440, now + 0.28);
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.32);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.32);
      } else if (soundType === 'alarm') {
        // Retro danger alert / siren pulse
        for (let i = 0; i < 3; i++) {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.type = 'sawtooth';
          const t = now + i * 0.09;
          osc.frequency.setValueAtTime(880, t);
          osc.frequency.setValueAtTime(440, t + 0.045);
          gain.gain.setValueAtTime(0.06, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.085);
          osc.connect(gain);
          gain.connect(this.audioCtx.destination);
          osc.start(t);
          osc.stop(t + 0.085);
        }
      } else if (soundType === 'fanfare') {
        // 8-bit victory fanfare
        const notes = [523.25, 659.25, 783.99, 1046.50];
        notes.forEach((freq, idx) => {
          const osc = this.audioCtx.createOscillator();
          const gain = this.audioCtx.createGain();
          osc.type = 'square';
          const dur = (idx === notes.length - 1) ? 0.35 : 0.08;
          osc.frequency.setValueAtTime(freq, now + idx * 0.09);
          gain.gain.setValueAtTime(0.07, now + idx * 0.09);
          gain.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.09 + dur);
          osc.connect(gain);
          gain.connect(this.audioCtx.destination);
          osc.start(now + idx * 0.09);
          osc.stop(now + idx * 0.09 + dur);
        });
      } else if (soundType === 'sad') {
        // Oops / sad slide
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.linearRampToValueAtTime(220, now + 0.3);
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
        osc.connect(gain);
        gain.connect(this.audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.35);
      }
    } catch (_) {
      // Audio autoplay policy can fail silently
    }
  }
}
