/**
 * js/input.js - Unified Input Management System for Duplinha NES
 * Supports dual keyboards, native USB/Bluetooth Gamepads, and on-screen Touch controls.
 */

class InputManager {
  constructor(onButtonEvent) {
    this.onButtonEvent = onButtonEvent; // Callback: (playerIdx, buttonName, isDown) => {}

    // Active key bindings
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
      // Prevent browser default on navigation keys during gameplay
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab'].includes(e.code)) {
        e.preventDefault();
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
      console.log(`Gamepad conectado: ${e.gamepad.id} no índice ${e.gamepad.index}`);
      if (!this.gamepadLoopActive) {
        this.gamepadLoopActive = true;
        this._pollGamepad();
      }
    });

    window.addEventListener('gamepaddisconnected', (e) => {
      console.log(`Gamepad desconectado do índice ${e.gamepad.index}`);
      delete this.prevGamepadState[e.gamepad.index];
    });

    // Start polling in case gamepad was already connected before load
    if ('getGamepads' in navigator) {
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

      // Standard Gamepad mapping
      const buttonsState = {
        BUTTON_A: gp.buttons[0]?.pressed || gp.buttons[1]?.pressed, // A or B on Xbox
        BUTTON_B: gp.buttons[2]?.pressed || gp.buttons[3]?.pressed, // X or Y on Xbox
        BUTTON_SELECT: gp.buttons[8]?.pressed || gp.buttons[4]?.pressed, // Select or L1
        BUTTON_START: gp.buttons[9]?.pressed || gp.buttons[5]?.pressed, // Start or R1
        BUTTON_UP: gp.buttons[12]?.pressed || (gp.axes[1] < -0.4),
        BUTTON_DOWN: gp.buttons[13]?.pressed || (gp.axes[1] > 0.4),
        BUTTON_LEFT: gp.buttons[14]?.pressed || (gp.axes[0] < -0.4),
        BUTTON_RIGHT: gp.buttons[15]?.pressed || (gp.axes[0] > 0.4)
      };

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
}
