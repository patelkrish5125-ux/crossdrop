# CrossDrop — Phase 1: Peer-to-Peer File Transfer

CrossDrop is a cross-device file sharing web application that transfers files directly between devices (Laptop ↔ Phone, Phone ↔ Laptop, Phone ↔ Phone) using **WebRTC RTCDataChannel** with a lightweight Node.js + WebSocket signaling server.

> **Phase 1 Scope**: Pure peer-to-peer file transfer over WebRTC. Files are **never** uploaded to or routed through the server. The signaling server exchanges only the temporary room metadata, SDP offers/answers, and ICE candidates necessary to connect the two browsers.

---

## Architecture

```text
               Signaling Server
             (Node.js + WebSocket)
                 ┌─────────────┐
                 │  Port 4000  │
                 └──────┬──────┘
                        │
             Pairing & Connection info
             (SDP Offer/Answer & ICE)
                        │
               ┌────────┴────────┐
               │                 │
          ┌────▼─────┐      ┌────▼─────┐
          │ Device A │◄────►│ Device B │
          │ (Laptop) │ WebRTC (Phone)  │
          └──────────┘DataChannel──────┘
                   (P2P File Data)
```

- **DataChannel Chunking**: Files are chunked into 16 KB frames with backpressure flow control (`bufferedAmount` & `bufferedAmountLowThreshold`).
- **File Assembly**: Chunks are reassembled into a native `Blob` on the receiving device and made available for instant download.

---

## Project Structure

```text
file transfer/
├── client/                     # Frontend React + TypeScript + Vite app
│   ├── src/
│   │   ├── services/
│   │   │   ├── signaling.ts   # WebSocket signaling client
│   │   │   └── webrtc.ts      # WebRTC PeerConnection & RTCDataChannel engine
│   │   ├── types/
│   │   │   └── index.ts       # Shared TypeScript types
│   │   ├── App.tsx            # Main application UI & state transitions
│   │   ├── index.css          # Responsive styling (mobile & desktop)
│   │   └── main.tsx           # React entry point
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
│
├── server/                     # Minimal signaling server
│   ├── src/
│   │   ├── index.ts           # WebSocket & HTTP health server
│   │   ├── roomManager.ts     # In-memory room store (max 2 peers, 6-digit codes)
│   │   └── types.ts           # Protocol message interfaces
│   ├── test/
│   │   └── roomManager.test.ts # Automated room lifecycle tests
│   ├── package.json
│   └── tsconfig.json
│
├── package.json                # Monorepo dev scripts (concurrently)
└── README.md
```

---

## Getting Started

### Prerequisites
- Node.js 18+ (tested with Node v24.15.0)
- npm 9+

### 1. Install Dependencies

You can install all dependencies across the project:

```bash
# In the project root:
npm install
cd server && npm install
cd ../client && npm install
```

### 2. Start Development Servers

Run both the signaling server and frontend simultaneously from the root directory:

```bash
npm run dev
```

Or run them individually in separate terminals:

```bash
# Terminal 1: Signaling Server (starts on http://0.0.0.0:4000)
cd server
npm run dev

# Terminal 2: Frontend Client (starts on http://0.0.0.0:3000)
cd client
npm run dev
```

- **Frontend URL**: `http://localhost:3000`
- **Signaling Server**: `ws://localhost:4000` (Health check at `http://localhost:4000/health`)

---

## How to Test Laptop ↔ Phone Transfer

### Step 1: Allow Windows Firewall (Crucial!)
If your phone gets "Connection timed out" or "Can't reach this site", Windows Firewall is blocking inbound connections to Node.js.
Right-click `scripts/allow-firewall.bat` and select **Run as administrator** (or run PowerShell as Administrator):
```powershell
netsh advfirewall firewall add rule name="CrossDrop Local Dev (3000, 4000)" dir=in action=allow protocol=TCP localport=3000,4000
```

### Step 2: (Optional) Install Trusted mkcert Certificate on Android Phone
To eliminate all browser security warnings in Chrome on Android:
1. On your laptop, install mkcert:
   ```powershell
   winget install FiloSottile.mkcert
   mkcert -install
   ```
2. Double-click `scripts/export-mkcert-ca.bat` to export `rootCA.crt`.
3. Transfer `rootCA.crt` to your phone (via USB, email, or Google Drive).
4. On Android, go to **Settings** > **Security** (or **Security & privacy**) > **More security settings** > **Encryption & credentials** > **Install a certificate** > **CA certificate** and select `rootCA.crt`.

### Step 3: Run Dev Server and Connect
1. Ensure both your Laptop and Phone are connected to the **same Wi-Fi network**.
2. Run `npm run dev`. The startup banner automatically prints your active phone URL:
   ```text
   ==================================================
     🔒 CrossDrop LAN Dev Server Ready (HTTPS)
     📱 Phone URL : https://10.166.29.128:3000
     💻 Local URL : https://localhost:3000
   ==================================================
   ```
3. Open `https://localhost:3000` on your laptop and click **Create Room**.
4. Open the displayed Phone URL (`https://10.166.29.128:3000`) on your phone.
5. Confirm the badge shows **🔒 Secure context: true**.
6. Tap **Join Room**, enter the 6-digit code, and tap **Connect**.
7. Both devices will display **Connected ✓** and files transfer directly peer-to-peer!

---

## Automated Tests

Run the signaling and room logic test suite:

```bash
npm run test:server
```

Test cases covered:
- [x] Unique 6-digit pairing code generation
- [x] Room creation with creator role
- [x] Invalid code rejection
- [x] Non-existent room handling
- [x] Join room with joiner role
- [x] Enforce max 2 devices per room (3rd device rejected with `ROOM_FULL`)
- [x] Peer discovery and message routing
- [x] Peer disconnection and notification
- [x] Automatic room cleanup on peer leave

---

## Known Limitations (Phase 1)

1. **Symmetric NATs / Strict Corporate Firewalls**: Phase 1 uses standard public STUN servers (`stun:stun.l.google.com:19302`). Environments requiring TURN relay servers are out of scope for Phase 1.
2. **Single Transfer at a Time**: One active file transfer per room session at any moment.
3. **Session Lifetime**: Rooms are strictly ephemeral and are automatically cleared when peers disconnect or after 30 minutes of inactivity.
