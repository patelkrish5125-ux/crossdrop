# CrossDrop — Cross-Device Peer-to-Peer File Transfer

CrossDrop is a lightweight cross-device file sharing web application that transfers files directly between devices (Laptop ↔ Phone, Phone ↔ Laptop, Phone ↔ Phone, Laptop ↔ Laptop) using **WebRTC RTCDataChannel** with a lightweight Node.js + WebSocket signaling server.

> **Privacy & Architecture**: Pure peer-to-peer file transfer over WebRTC. Files are **never** uploaded to or routed through any server. The signaling server exchanges only temporary room metadata, SDP offers/answers, and ICE candidates necessary to establish the direct browser-to-browser connection.

---

## Phase 2 Features

1. **QR Code Pairing**:
   - Creator generates room and gets an instant QR code alongside the 6-digit code.
   - Joiner scans with phone camera or clicks the link containing `?join=XXXXXX` to automatically connect.
   - Clean, zero-dependency pure TypeScript SVG vector QR generation.

2. **Multi-File Queue & Progress**:
   - Send multiple files in a single session.
   - Per-file progress bars, file sizes, and cumulative overall transfer metrics.
   - Download list with per-file status, individual save buttons, and instant blob access.

3. **Desktop Drag-and-Drop + Mobile Native Picker**:
   - Seamless dropzone on desktop supporting multi-file drops.
   - Native OS file picker preserved for mobile browsers.

4. **Real-Time Speed & ETA Estimation**:
   - Dynamic sliding-window transfer speed calculation (`MB/s` or `KB/s`).
   - Real-time ETA estimation based on remaining bytes.

5. **Cancel Transfer**:
   - Instant cancellation on either sender or receiver side.
   - Aborts ongoing file stream, cleans up partial chunks, notifies peer via control message, and keeps the `RTCDataChannel` open for subsequent transfers.

6. **Device Naming**:
   - Local device naming stored in `localStorage` (defaults to OS/device type).
   - Automatically exchanged between peers upon WebRTC connection establishment.

7. **Signaling Resiliency & Exponential Backoff**:
   - Automatic reconnect with exponential backoff on network dropouts.
   - Comprehensive connection state model: `DISCONNECTED`, `CONNECTING`, `WAKING`, `SIGNALING_CONNECTED`, `WAITING_FOR_PEER`, `NEGOTIATING`, `CONNECTED`, `TRANSFERRING`, `COMPLETED`, `RECONNECTING`, `ERROR`.

8. **Render Free Tier Cold-Start & Keep-Alive Support**:
   - Dedicated lightweight `GET /health` endpoint for instant health checking and external pinging.
   - Automatic client-side wake detection ("Waking server..." spinner) when Render is spinning up from idle.
   - Optional server self-ping mechanism (`KEEP_ALIVE_URL`) and external uptime monitor integration instructions.

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
- **File Assembly**: Chunks are reassembled into native `Blob`s on the receiving device and presented in a download queue.

---

## Project Structure

```text
crossdrop/
├── client/                     # Frontend React + TypeScript + Vite app
│   ├── src/
│   │   ├── services/
│   │   │   ├── signaling.ts   # WebSocket signaling client + reconnect backoff + wake detection
│   │   │   └── webrtc.ts      # WebRTC PeerConnection, multi-file queue, speed/ETA & cancellation
│   │   ├── utils/
│   │   │   └── qr.ts          # Pure vector SVG QR code generator
│   │   ├── types/
│   │   │   └── index.ts       # Shared Phase 2 TypeScript types
│   │   ├── App.tsx            # Main application UI, QR modal, dropzone & transfer queue
│   │   ├── index.css          # Responsive styling (mobile & desktop)
│   │   └── main.tsx           # React entry point
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   └── vite.config.ts
│
├── server/                     # Minimal signaling server
│   ├── src/
│   │   ├── index.ts           # WebSocket server, HTTP /health endpoint & keep-alive
│   │   ├── roomManager.ts     # In-memory room store (max 2 peers, 6-digit codes)
│   │   └── types.ts           # Protocol message interfaces
│   ├── test/
│   │   └── roomManager.test.ts # Automated room lifecycle tests
│   ├── package.json
│   └── tsconfig.json
│
├── Dockerfile                  # Production container build (node:20-slim, multi-stage)
├── render.yaml                 # Render Blueprint configuration
├── package.json                # Monorepo dev & build scripts
└── README.md
```

---

## Getting Started

### Prerequisites
- Node.js 18+ (tested with Node v20/v24)
- npm 9+

### 1. Install Dependencies

```bash
npm run install:all
```

### 2. Start Development Servers

Run both the signaling server and frontend simultaneously:

```bash
npm run dev
```

- **Frontend URL**: `http://localhost:3000`
- **Signaling Server**: `ws://localhost:4000` (Health check at `http://localhost:4000/health`)

---

## Render Deployment & Keep-Alive Setup

Render Free instances automatically spin down after 15 minutes of inactivity (no external incoming HTTP requests).

### Recommended Keep-Alive Configuration (UptimeRobot / Cron-Job)

To keep your free instance warm during active periods:
1. Go to [UptimeRobot](https://uptimerobot.com) (free tier allows up to 50 monitors at 5-minute intervals).
2. Create a new **HTTP(s)** monitor:
   - **Friendly Name**: `CrossDrop Server`
   - **URL**: `https://your-app-name.onrender.com/health`
   - **Monitoring Interval**: `5 minutes`
3. CrossDrop's `/health` endpoint responds with:
   ```json
   {
     "status": "ok",
     "timestamp": "2026-09-13T13:00:00.000Z",
     "uptime": 123.45
   }
   ```
4. This consumes virtually zero CPU or memory and prevents the 15-minute idle spin-down.

### Client-Side Cold-Start UX

If the server has spun down into idle mode:
- The CrossDrop client detects cold starts via `/health` probing.
- The UI transitions into a friendly **"Waking server..."** state with a pulsing spinner instead of failing immediately.
- Once the server responds, signaling connects automatically without requiring page reloads.

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

## Known Platform & WebRTC Limitations

1. **Symmetric NATs / Strict Enterprise Firewalls**: CrossDrop uses standard public STUN servers (`stun:stun.l.google.com:19302`). Networks that block direct P2P UDP or implement symmetric NAT without hairpinned endpoints require a TURN relay server.
2. **Render Free Tier Monthly Quota**: Render Free tier provides 750 free instance hours per month. If you run multiple services on the same free account, your instance hours may be exhausted before the end of the calendar month.
3. **Session Lifetime**: Rooms are strictly ephemeral and are automatically cleared when peers disconnect or after 30 minutes of inactivity.
