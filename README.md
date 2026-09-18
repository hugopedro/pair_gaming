# 🎮 Duplinha NES - Emulador Online P2P Co-op (2 Jogadores)

> Um emulador completo de Nintendo Entertainment System (NES) rodando no navegador com **multiplayer online cooperativo/competitivo de 2 jogadores via WebRTC P2P (Peer-to-Peer)**, sem precisar de nenhum servidor intermediário!

---

## ✨ Características Principais

* **Conexão Direta Sem Servidor (WebRTC P2P via PeerJS):**
  * O sinal viaja direto da sua casa para a da sua amiga pela internet.
  * Custo zero com servidores e menor latência possível.
* **Transmissão em Tempo Real com Zero Desync:**
  * O Host roda a emulação com precisão de 60 FPS e transmite o vídeo e áudio nativo via WebRTC MediaStream.
  * **Sua amiga NÃO precisa ter a ROM!** Você pode carregar qualquer jogo e ela já começa a jogar instantaneamente.
  * Impossível haver dessincronização física de memória ou colisão.
* **Compatível com Qualquer ROM (.nes):**
  * Arraste e solte (*Drag & Drop*) qualquer arquivo `.nes` para dentro da tela ou use o botão de seleção.
  * Acompanha o clássico **Pong (2 Players)** homebrew pronto para jogar imediatamente!
* **Controles Universais:**
  * **Player 1 & Player 2 no mesmo teclado** (para jogar juntos no mesmo PC).
  * **Suporte a Gamepads USB / Bluetooth** (Xbox, PlayStation, 8BitDo, controles estilo NES/SNES).
  * **Controles Virtuais Touch** na tela para celulares ou tablets.
  * **Botão "Inverter (P1 ⇄ P2)":** Alterne facilmente quem pilota qual jogador com 1 clique.
* **Fidelidade e Recursos Retrô:**
  * Filtro de **Scanlines CRT** nostálgico com brilho de fósforo.
  * **Save State / Load State:** Salve seu progresso no jogo a qualquer momento com 1 clique (`💾 Salvar` / `📂 Carregar`).
  * **Medidor de Ping ao Vivo:** Acompanhe a latência da conexão em milissegundos.
  * **Modo Tela Cheia (⛶)** mantendo a proporção 4:3 original do NES.

---

## 🕹️ Como Jogar com Sua Amiga Online (Passo a Passo)

1. Abra o jogo no navegador (Host).
2. Clique no botão azul **`🔗 Jogar Online (P2P)`**.
3. Clique em **`⚡ GERAR LINK DA SALA`**.
4. Clique em **`📋 Copiar Link`** e mande para ela (via WhatsApp, Discord, etc.).
5. Quando ela abrir o link no navegador dela, **a conexão será feita automaticamente**!
6. Escolha qualquer jogo (carregue uma ROM `.nes` ou use o Pong embutido) e divirtam-se jogando juntos!

---

## ⌨️ Mapeamento de Controles

| Botão NES | Player 1 (Host / Local) | Player 2 (Client / Local) | Gamepad (USB / Bluetooth) |
| :--- | :--- | :--- | :--- |
| **D-Pad (Mover)** | `W` `A` `S` `D` | `↑` `←` `↓` `→` | D-Pad ou Analógico Esquerdo |
| **Botão B** | `J` | `Z` ou `Num 1` | Botão X (Xbox) / Quadrado (PS) |
| **Botão A** | `K` | `X` ou `Num 2` | Botão A (Xbox) / Cruz (PS) |
| **Turbo B / A** | `U` / `I` | `Num 4` / `Num 5` | Gatilhos L1 / R1 |
| **Select** | `Shift` ou `Tab` | `Num 0` ou `[` | Select / Share / Back |
| **Start** | `Enter` ou `Espaço` | `Num Enter` ou `]` | Start / Options |

---

## 🚀 Como Executar Localmente

Como o emulador utiliza Web Workers, Web Audio API e WebRTC, é recomendável rodar através de um servidor web local simples (para evitar restrições de segurança do protocolo `file:///` ao carregar ROMs locais):

### Opção 1: Extensão Live Server (VS Code)
Abra a pasta `duplinha_nes` no VS Code e clique em **"Go Live"** no rodapé.

### Opção 2: Node.js (npx serve)
```bash
cd duplinha_nes
npx serve .
```

### Opção 3: Python
```bash
cd duplinha_nes
python -m http.server 8000
```
Em seguida, abra `http://localhost:8000` no seu navegador!

---

## 📁 Estrutura do Projeto

```text
duplinha_nes/
├── index.html            # Estrutura principal da interface e gabinete NES
├── css/
│   └── style.css         # Estilização visual retrô, CRT scanlines e touch controls
├── js/
│   ├── emulator.js       # Motor de emulação NES (JSNES + Web Audio + MediaStream)
│   ├── input.js          # Sistema de entradas (Teclados, Gamepads e Touch)
│   ├── multiplayer.js    # Gerenciador WebRTC P2P (PeerJS, Audio/Video Stream e DataChannel)
│   └── app.js            # Orquestrador mestre da interface e eventos
├── roms/
│   └── pong.nes          # Jogo homebrew clássico de 2 jogadores embutido
├── jsnes.min.js          # Biblioteca JSNES local
└── peerjs.min.js         # Biblioteca PeerJS local
```

---

## 💡 Dicas de Jogos Recomendados para 2 Jogadores
- **Co-op:** *Contra*, *Super C*, *Battle City*, *Chip 'n Dale Rescue Rangers 1 & 2*, *Teenage Mutant Ninja Turtles II / III*, *Double Dragon II*, *Ice Climber*, *Bubble Bobble*, *Guerrilla War*.
- **Versus:** *Dr. Mario*, *Tetris*, *Micro Machines*, *Tecmo Super Bowl*, *Track & Field*, *Pong*.
