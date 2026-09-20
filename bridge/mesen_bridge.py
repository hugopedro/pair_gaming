#!/usr/bin/env python3
"""
bridge/mesen_bridge.py - Input Relay Bridge for Duplinha SNES (Mesen Stream)
Receives Player 2 WebRTC inputs from Sandy's browser via WebSocket (localhost:8088)
and injects them into Windows as native gamepad (vgamepad) or keyboard events for Mesen.
"""

import sys
import json
import asyncio
import ctypes

# Try importing vgamepad (Virtual Xbox 360 Controller)
VGAMEPAD_AVAILABLE = False
try:
    import vgamepad as vg
    gamepad = vg.VX360Gamepad()
    VGAMEPAD_AVAILABLE = True
    print("🎮 [Bridge] Virtual Xbox 360 Controller (vgamepad) ATIVO!")
    print("   Sandy será reconhecida automaticamente pelo Mesen como um controle Xbox real!")
except Exception:
    print("⌨️  [Bridge] vgamepad não encontrado. Usando emulação de Teclado nativa do Windows.")
    print("   (Dica: se quiser controle virtual Xbox 360, rode: pip install vgamepad)")

# Windows Virtual-Key Codes for Player 2 Keyboard fallback
# Mesen -> Settings -> Input -> Port 2 (Player 2)
KEY_MAP = {
    'BUTTON_UP': 0x49,      # 'I'
    'BUTTON_DOWN': 0x4B,    # 'K'
    'BUTTON_LEFT': 0x4A,    # 'J'
    'BUTTON_RIGHT': 0x4C,   # 'L'
    'BUTTON_A': 0x58,       # 'X'
    'BUTTON_B': 0x5A,       # 'Z'
    'BUTTON_X': 0x53,       # 'S'
    'BUTTON_Y': 0x41,       # 'A'
    'BUTTON_L': 0x51,       # 'Q'
    'BUTTON_R': 0x57,       # 'W'
    'BUTTON_SELECT': 0x56,  # 'V'
    'BUTTON_START': 0x42    # 'B'
}

# vgamepad button mapping
VG_MAP = {}
if VGAMEPAD_AVAILABLE:
    VG_MAP = {
        'BUTTON_UP': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_UP,
        'BUTTON_DOWN': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_DOWN,
        'BUTTON_LEFT': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_LEFT,
        'BUTTON_RIGHT': vg.XUSB_BUTTON.XUSB_GAMEPAD_DPAD_RIGHT,
        'BUTTON_A': vg.XUSB_BUTTON.XUSB_GAMEPAD_B,      # SNES A -> Xbox B
        'BUTTON_B': vg.XUSB_BUTTON.XUSB_GAMEPAD_A,      # SNES B -> Xbox A
        'BUTTON_X': vg.XUSB_BUTTON.XUSB_GAMEPAD_Y,      # SNES X -> Xbox Y
        'BUTTON_Y': vg.XUSB_BUTTON.XUSB_GAMEPAD_X,      # SNES Y -> Xbox X
        'BUTTON_L': vg.XUSB_BUTTON.XUSB_GAMEPAD_LEFT_SHOULDER,
        'BUTTON_R': vg.XUSB_BUTTON.XUSB_GAMEPAD_RIGHT_SHOULDER,
        'BUTTON_SELECT': vg.XUSB_BUTTON.XUSB_GAMEPAD_BACK,
        'BUTTON_START': vg.XUSB_BUTTON.XUSB_GAMEPAD_START
    }

user32 = ctypes.windll.user32

def send_key(vk_code, is_down):
    """Simulates keyboard event via Windows keybd_event"""
    flags = 0 if is_down else 2  # 0 = KEYEVENTF_KEYDOWN, 2 = KEYEVENTF_KEYUP
    user32.keybd_event(vk_code, 0, flags, 0)

def handle_input(button, is_down):
    if VGAMEPAD_AVAILABLE and button in VG_MAP:
        vg_btn = VG_MAP[button]
        if is_down:
            gamepad.press_button(button=vg_btn)
        else:
            gamepad.release_button(button=vg_btn)
        gamepad.update()
    elif button in KEY_MAP:
        vk = KEY_MAP[button]
        send_key(vk, is_down)

async def handler(websocket):
    print("✨ [Bridge] Navegador do Hugo conectado na porta 8088!")
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                button = data.get('button')
                is_down = bool(data.get('isDown'))
                if button:
                    handle_input(button, is_down)
            except Exception as e:
                print("Erro processando entrada:", e)
    except Exception:
        pass
    finally:
        print("🔌 [Bridge] Navegador desconectado.")

async def main():
    import websockets
    port = 8088
    print("=" * 65)
    print("   🎮 DUPLINHA SNES - MESEN INPUT BRIDGE (PLAYER 2)")
    print("=" * 65)
    if not VGAMEPAD_AVAILABLE:
        print("\n📋 Mapeamento de Teclas no Mesen para o Player 2 (Port 2):")
        print("   • Direcionais: I (Cima), K (Baixo), J (Esquerda), L (Direita)")
        print("   • Botões A/B:  X (A), Z (B)")
        print("   • Botões X/Y:  S (X), A (Y)")
        print("   • Ombros L/R:  Q (L), W (R)")
        print("   • Select/Start: V (Select), B (Start)")
        print("\n   Configure esses botões em: Mesen > Settings > Input > Port 2\n")
    print(f"🚀 Aguardando conexão do navegador em ws://localhost:{port}...")
    print("=" * 65)
    async with websockets.serve(handler, "localhost", port):
        await asyncio.Future()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nBridge encerrada.")
