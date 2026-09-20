/**
 * js/input.js - Unified Input Management System for Duplinha NES
 * Supports dual keyboards, native USB/Bluetooth Gamepads, and on-screen Touch controls.
 */

class InputManager {
  constructor(onButtonEvent, onGamepadStatusChange = null, options = {}) {
    this.onButtonEvent = onButtonEvent; // Callback: (playerIdx, buttonName, isDown) => {}
    this.onGamepadStatusChange = onGamepadStatusChange; // Callback: (playerIdx, gamepadId, isConnected) => {}
    this.system = options.system || 'nes'; // 'nes' | 'sms' | 'snes'

    // Active key bindings
    if (this.system === 'snes') {
      this.keyMapP1 = {
        KeyW: 'BUTTON_UP',
        KeyS: 'BUTTON_DOWN',
        KeyA: 'BUTTON_LEFT',
        KeyD: 'BUTTON_RIGHT',
        KeyJ: 'BUTTON_B',
        KeyK: 'BUTTON_A',
        KeyU: 'BUTTON_Y',
        KeyI: 'BUTTON_X',
        KeyQ: 'BUTTON_L',
        KeyE: 'BUTTON_R',
        ShiftLeft: 'BUTTON_SELECT',
        Tab: 'BUTTON_SELECT',
        Enter: 'BUTTON_START',
        Space: 'BUTTON_START'
      };

      this.keyMapP2 = {
        ArrowUp: 'BUTTON_UP',
        ArrowDown: 'BUTTON_DOWN',
        ArrowLeft: 'BUTTON_LEFT',
        ArrowRight: 'BUTTON_RIGHT',
        Numpad1: 'BUTTON_B',
        KeyZ: 'BUTTON_B',
        Numpad2: 'BUTTON_A',
        KeyX: 'BUTTON_A',
        Numpad4: 'BUTTON_Y',
        Numpad5: 'BUTTON_X',
        Numpad7: 'BUTTON_L',
        Numpad8: 'BUTTON_R',
        Numpad0: 'BUTTON_SELECT',
        NumpadEnter: 'BUTTON_START'
      };
    } else {
      this.keyMapP1 = {
        KeyW: 'BUTTON_UP',
        KeyS: 'BUTTON_DOWN',
        KeyA: 'BUTTON_LEFT',
        KeyD: 'BUTTON_RIGHT',
        KeyJ: 'BUTTON_B',
        KeyK: 'BUTTON_A',
        KeyU: 'BUTTON_TURBO_B',
        KeyI: 'BUTTON_TURBO_A',
        ShiftLeft: 'BUTTON_SELECT',
        Tab: 'BUTTON_SELECT',
        Enter: 'BUTTON_START',
        Space: 'BUTTON_START'
      };

      this.keyMapP2 = {
        ArrowUp: 'BUTTON_UP',
        ArrowDown: 'BUTTON_DOWN',
        ArrowLeft: 'BUTTON_LEFT',
        ArrowRight: 'BUTTON_RIGHT',
        Numpad1: 'BUTTON_B',
        KeyZ: 'BUTTON_B',
        Numpad2: 'BUTTON_A',
        KeyX: 'BUTTON_A',
        Numpad4: 'BUTTON_TURBO_B',
        Numpad5: 'BUTTON_TURBO_A',
        Numpad0: 'BUTTON_SELECT',
        NumpadEnter: 'BUTTON_START'
      };
    }

    // Swap role: if true, local controls act as Player 2 instead of Player 1
    this.isSwapped = false;

    // Track active pressed state to prevent repeated keydown spam
    this.pressedP1 = new Set();
    this.pressedP2 = new Set();

    // Gamepad state tracking for edge detection
    this.prevGamepadState = {};
    this.gamepadLoopActive = false;

    this._initKeyboard();
    this._initGamepad();
    this._initTouchControls();
  }

  _initKeyboard() {
    window.addEventListener('keydown', (e) => {
      // If typing in any input/textarea, or if in-game chat is active, ignore emulator controls
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        return;
      }
      if (window.inGameChat && window.inGameChat.isOpen) {
        return;
      }

      // Prevent browser default on navigation and shortcut keys during gameplay
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab', 'Backspace'].includes(e.code)) {
        e.preventDefault();
      }

      // Quick Shortcut Keys for Player 1: Backspace / KeyR = REWIND, KeyC = COPILOT
      if (e.code === 'Backspace' || e.code === 'KeyR') {
        if (!e.repeat && this.onButtonEvent) {
          this.onButtonEvent(1, 'REWIND', true);
        }
        return;
      }
      if (e.code === 'KeyC') {
        if (!e.repeat && this.onButtonEvent) {
          this.onButtonEvent(1, 'COPILOT', true);
        }
        return;
      }

      // Check Player 1
      if (this.keyMapP1[e.code]) {
        const btn = this.keyMapP1[e.code];
        if (!this.pressedP1.has(btn)) {
          this.pressedP1.add(btn);
          const targetPlayer = this.isSwapped ? 2 : 1;
          if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btn, true);
        }
      }

      // Check Player 2
      if (this.keyMapP2[e.code]) {
        const btn = this.keyMapP2[e.code];
        if (!this.pressedP2.has(btn)) {
          this.pressedP2.add(btn);
          const targetPlayer = this.isSwapped ? 1 : 2;
          if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btn, true);
        }
      }
    });

    window.addEventListener('keyup', (e) => {
      if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) {
        return;
      }
      if (window.inGameChat && window.inGameChat.isOpen) {
        return;
      }
      if (this.keyMapP1[e.code]) {
        const btn = this.keyMapP1[e.code];
        if (this.pressedP1.has(btn)) {
          this.pressedP1.delete(btn);
          const targetPlayer = this.isSwapped ? 2 : 1;
          if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btn, false);
        }
      }

      if (this.keyMapP2[e.code]) {
        const btn = this.keyMapP2[e.code];
        if (this.pressedP2.has(btn)) {
          this.pressedP2.delete(btn);
          const targetPlayer = this.isSwapped ? 1 : 2;
          if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btn, false);
        }
      }
    });

    // Clear all pressed keys on window blur
    window.addEventListener('blur', () => {
      this.pressedP1.forEach((btn) => {
        const targetPlayer = this.isSwapped ? 2 : 1;
        if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btn, false);
      });
      this.pressedP2.forEach((btn) => {
        const targetPlayer = this.isSwapped ? 1 : 2;
        if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btn, false);
      });
      this.pressedP1.clear();
      this.pressedP2.clear();
    });
  }

  _initGamepad() {
    window.addEventListener('gamepadconnected', (e) => {
      const playerNum = (e.gamepad.index === 0) ? (this.isSwapped ? 2 : 1) : (this.isSwapped ? 1 : 2);
      console.log(`🎮 Gamepad conectado: ${e.gamepad.id} no índice ${e.gamepad.index} -> Player ${playerNum}`);
      if (this.onGamepadStatusChange) {
        this.onGamepadStatusChange(playerNum, e.gamepad.id, true);
      }
      if (!this.gamepadLoopActive) {
        this.gamepadLoopActive = true;
        this._pollGamepad();
      }
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      const playerNum = (e.gamepad.index === 0) ? (this.isSwapped ? 2 : 1) : (this.isSwapped ? 1 : 2);
      console.log(`Gamepad desconectado do índice ${e.gamepad.index}`);
      delete this.prevGamepadState[e.gamepad.index];
      if (this.onGamepadStatusChange) {
        this.onGamepadStatusChange(playerNum, e.gamepad.id, false);
      }
    });

    // Start polling and check initial gamepads
    if ('getGamepads' in navigator) {
      const gamepads = navigator.getGamepads();
      for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i] && this.onGamepadStatusChange) {
          const playerNum = (i === 0) ? (this.isSwapped ? 2 : 1) : (this.isSwapped ? 1 : 2);
          this.onGamepadStatusChange(playerNum, gamepads[i].id, true);
        }
      }
      this.gamepadLoopActive = true;
      this._pollGamepad();
    }
  }

  _pollGamepad() {
    if (!this.gamepadLoopActive) return;

    const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (let i = 0; i < gamepads.length; i++) {
      const gp = gamepads[i];
      if (!gp) continue;

      // Assign first gamepad to Player 1, second to Player 2
      const playerNum = (i === 0) ? (this.isSwapped ? 2 : 1) : (this.isSwapped ? 1 : 2);
      if (!this.prevGamepadState[gp.index]) {
        this.prevGamepadState[gp.index] = {};
      }
      const prevState = this.prevGamepadState[gp.index];

      // Xbox 360 Native Mapping
      // A (Green) = buttons[0], B (Red) = buttons[1], X (Blue) = buttons[2], Y (Yellow) = buttons[3]
      // LB = buttons[4], RB = buttons[5], LT = buttons[6], RT = buttons[7]
      // Back/View = buttons[8], Start/Menu = buttons[9]
      // D-Pad: Up (12), Down (13), Left (14), Right (15)
      // Left Analog: axes[0] (X), axes[1] (Y) with 0.3 deadzone
      const isLtPressed = Boolean(gp.buttons[6]?.pressed || (gp.buttons[6]?.value && gp.buttons[6].value > 0.3));
      const isRtPressed = Boolean(gp.buttons[7]?.pressed || (gp.buttons[7]?.value && gp.buttons[7].value > 0.3));
      const isLbPressed = Boolean(gp.buttons[4]?.pressed);
      const isRbPressed = Boolean(gp.buttons[5]?.pressed);

      let buttonsState = {};
      if (this.system === 'snes') {
        buttonsState = {
          BUTTON_B: Boolean(gp.buttons[0]?.pressed), // Xbox A -> SNES B (Bottom)
          BUTTON_A: Boolean(gp.buttons[1]?.pressed), // Xbox B -> SNES A (Right)
          BUTTON_Y: Boolean(gp.buttons[2]?.pressed), // Xbox X -> SNES Y (Left)
          BUTTON_X: Boolean(gp.buttons[3]?.pressed), // Xbox Y -> SNES X (Top)
          BUTTON_L: isLtPressed,                     // Xbox LT -> SNES L
          BUTTON_R: isRtPressed,                     // Xbox RT -> SNES R
          BUTTON_SELECT: Boolean(gp.buttons[8]?.pressed),                       // Back / View
          BUTTON_START: Boolean(gp.buttons[9]?.pressed),                        // Start / Menu
          BUTTON_UP: Boolean(gp.buttons[12]?.pressed || (gp.axes[1] !== undefined && gp.axes[1] < -0.3)),
          BUTTON_DOWN: Boolean(gp.buttons[13]?.pressed || (gp.axes[1] !== undefined && gp.axes[1] > 0.3)),
          BUTTON_LEFT: Boolean(gp.buttons[14]?.pressed || (gp.axes[0] !== undefined && gp.axes[0] < -0.3)),
          BUTTON_RIGHT: Boolean(gp.buttons[15]?.pressed || (gp.axes[0] !== undefined && gp.axes[0] > 0.3))
        };
        // For Player 2 on SNES, also allow LB/RB as L/R
        if (playerNum !== 1) {
          if (isLbPressed) buttonsState.BUTTON_L = true;
          if (isRbPressed) buttonsState.BUTTON_R = true;
        }
      } else {
        buttonsState = {
          BUTTON_A: Boolean(gp.buttons[0]?.pressed || gp.buttons[1]?.pressed), // A (Green) or B (Red)
          BUTTON_B: Boolean(gp.buttons[2]?.pressed || gp.buttons[3]?.pressed), // X (Blue) or Y (Yellow)
          BUTTON_TURBO_A: playerNum === 1 ? isRtPressed : Boolean(isRbPressed || isRtPressed), // RT for P1 (RB is Load State)
          BUTTON_TURBO_B: playerNum === 1 ? isLtPressed : Boolean(isLbPressed || isLtPressed), // LT for P1 (LB is Save State)
          BUTTON_SELECT: Boolean(gp.buttons[8]?.pressed),                       // Back / View
          BUTTON_START: Boolean(gp.buttons[9]?.pressed),                        // Start / Menu
          BUTTON_UP: Boolean(gp.buttons[12]?.pressed || (gp.axes[1] !== undefined && gp.axes[1] < -0.3)),
          BUTTON_DOWN: Boolean(gp.buttons[13]?.pressed || (gp.axes[1] !== undefined && gp.axes[1] > 0.3)),
          BUTTON_LEFT: Boolean(gp.buttons[14]?.pressed || (gp.axes[0] !== undefined && gp.axes[0] < -0.3)),
          BUTTON_RIGHT: Boolean(gp.buttons[15]?.pressed || (gp.axes[0] !== undefined && gp.axes[0] > 0.3))
        };
      }

      // Player 1 dedicated quick save / load state / rewind / co-pilot triggers on controller
      if (playerNum === 1) {
        buttonsState.SAVE_STATE = isLbPressed;
        buttonsState.LOAD_STATE = isRbPressed;
        buttonsState.REWIND = Boolean(gp.buttons[10]?.pressed);  // Left Stick Click (L3)
        buttonsState.COPILOT = Boolean(gp.buttons[11]?.pressed); // Right Stick Click (R3)
      }

      for (const [btn, isDown] of Object.entries(buttonsState)) {
        if (Boolean(isDown) !== Boolean(prevState[btn])) {
          prevState[btn] = isDown;
          if (this.onButtonEvent) this.onButtonEvent(playerNum, btn, isDown);
        }
      }
    }

    requestAnimationFrame(() => this._pollGamepad());
  }

  _initTouchControls() {
    const touchElements = document.querySelectorAll('.touch-btn');
    touchElements.forEach((elem) => {
      const btnName = elem.getAttribute('data-button');
      if (!btnName) return;

      const handlePress = (e) => {
        e.preventDefault();
        elem.classList.add('pressed');
        const targetPlayer = this.isSwapped ? 2 : 1;
        if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btnName, true);
      };

      const handleRelease = (e) => {
        e.preventDefault();
        elem.classList.remove('pressed');
        const targetPlayer = this.isSwapped ? 2 : 1;
        if (this.onButtonEvent) this.onButtonEvent(targetPlayer, btnName, false);
      };

      elem.addEventListener('touchstart', handlePress, { passive: false });
      elem.addEventListener('touchend', handleRelease, { passive: false });
      elem.addEventListener('touchcancel', handleRelease, { passive: false });
      elem.addEventListener('mousedown', handlePress);
      elem.addEventListener('mouseup', handleRelease);
      elem.addEventListener('mouseleave', handleRelease);
    });
  }

  toggleSwapRoles() {
    this.isSwapped = !this.isSwapped;
    return this.isSwapped;
  }

  /**
   * Triggers haptic feedback / rumble on connected Xbox controllers
   * Patterns: 'soft', 'pulse', 'heartbeat', 'strong', 'medium'
   */
  vibrate(pattern = 'medium') {
    if (!('getGamepads' in navigator)) return;
    try {
      const gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
      let effect = { startDelay: 0, duration: 200, weakMagnitude: 0.5, strongMagnitude: 0.5 };
      if (pattern === 'soft') {
        effect = { startDelay: 0, duration: 120, weakMagnitude: 0.35, strongMagnitude: 0.1 };
      } else if (pattern === 'pulse') {
        effect = { startDelay: 0, duration: 180, weakMagnitude: 0.8, strongMagnitude: 0.4 };
      } else if (pattern === 'heartbeat') {
        effect = { startDelay: 0, duration: 260, weakMagnitude: 0.7, strongMagnitude: 0.7 };
      } else if (pattern === 'strong') {
        effect = { startDelay: 0, duration: 350, weakMagnitude: 1.0, strongMagnitude: 0.8 };
      }

      for (let i = 0; i < gamepads.length; i++) {
        const gp = gamepads[i];
        if (gp && gp.vibrationActuator && typeof gp.vibrationActuator.playEffect === 'function') {
          gp.vibrationActuator.playEffect('dual-rumble', effect).catch(() => {});
        }
      }
    } catch (_) {
      // Haptics fail silently if unsupported
    }
  }
}

