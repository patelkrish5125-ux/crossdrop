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

## Critical Engineering Update — Communication Reliability & Hybrid Transport Architecture

### 1. Robust Signaling Protocol & Deduplication
- **Message Metadata**: All messages across client and server carry structured metadata: `id`, `timestamp`, `roomId`, `senderPeerId`, `targetPeerId`, and `replyTo`.
- **Server Message Deduplication**: The signaling server maintains an in-memory TTL deduplication cache to prevent re-processing duplicate requests caused by network retries or simultaneous room-join attempts.
- **Heartbeat & Latency Measurement**: Client issues periodic lightweight ping frames; the server responds immediately with server timestamps to calculate real round-trip network latency.
- **Stale Socket Pruning**: Sockets with unacknowledged pings or broken connections are safely pruned during room queries to prevent routing signals to dead endpoints.

### 2. WebRTC Perfect Negotiation & Connection Reliability
- **W3C Perfect Negotiation Pattern**: Implements deterministic polite/impolite peer roles based on peer IDs. Offer collisions (glare) are resolved deterministically: polite peers roll back local descriptions cleanly while impolite peers reject conflicting offers, preventing negotiation lockups.
- **Safe ICE Candidate Queuing**: Candidates arriving before `setRemoteDescription` completes are held in a queued FIFO buffer and flushed sequentially only after the remote description is successfully installed.
- **True Connection Readiness**: Devices are declared ready for transfer (`CONNECTED`) **only** when an `RTCDataChannel` is in the `open` state and the `RTCPeerConnection` is connected. Signaling connection alone never declares transfer readiness.
- **Automatic Recovery State Machine**: Bounded exponential backoff with jitter reconnects signaling dropouts, while temporary WebRTC link drops trigger automatic ICE restarts (`pc.restartIce()`) without resetting in-progress file transfer metadata.

### 3. Transport Path Diagnostics & Wi-Fi LAN Optimization
- **Real-Time Candidate Inspection**: Regularly samples `pc.getStats()` to identify the active nominated candidate pair.
- **Accurate Transport Classification**: Accurately reports candidate path type:
  - `Direct Wi-Fi / Local LAN (Host)`: Devices communicating directly on the same local subnet without relay.
  - `STUN Direct (Server Reflexive NAT P2P)`: Direct peer-to-peer connection established across NATs via STUN.
  - `TURN Relay (Relayed Traffic)`: Relayed path used when direct UDP is blocked.
- **High-Speed Transfer**: Pipelined 64 KB SCTP chunking with 4 MB backpressure watermark and 2 MB disk batching achieving high-throughput LAN transfers (exceeding 5 MB/s benchmark target).

### 4. Bluetooth Capability & Future Hybrid Architecture
- **Browser Capability Reality**: Standard browser Web Bluetooth (`navigator.bluetooth`) strictly implements GATT Central (client) mode only and **cannot** act as a GATT Peripheral (server) to accept incoming connections or advertise services. Major browsers (Safari, Firefox) have completely disabled Web Bluetooth.
- **Zero-Fake Reporting**: CrossDrop never fakes a Bluetooth connection. If browser-to-browser BLE is unavailable, the UI reports: `"Bluetooth-assisted device discovery is not available in this browser version."`
- **Future Hybrid Transport Architecture**:
  ```text
  TransportManager
      │
      ├── WebRTC Wi-Fi / Network Transport (Active Primary Transport)
      │
      ├── Bluetooth LE Adapter (Capability Detection / Future Native Discovery)
      │
      ├── Future Native Wi-Fi Direct Adapter (Android / iOS native wrapper)
      │
      └── Future Native Bluetooth Adapter (Native BLE Peripheral Daemon)
  ```

### 5. Developer & Diagnostics Panel
- Accessible via the **📶 Diagnostics** button in the header.
- Displays:
  - Real-time signaling state & server round-trip latency
  - WebRTC connection state, ICE state, and DataChannel state
  - Selected candidate pair path, local/remote candidate types, and RTT
  - Live measured throughput, session bytes, and DataChannel buffer levels
  - User-triggered interactive Bluetooth capability test
  - Reconnect count and last recorded connection error

---

## Architecture

```text
               Signaling Server
             (Node.js + WebSocket)
                 ┌─────────────┐
                 │  Port 3000  │
                 └──────┬──────┘
                        │
             Pairing & Connection info
             (Metadata, SDP & ICE)
                        │
               ┌────────┴────────┐
               │                 │
          ┌────▼─────┐      ┌────▼─────┐
          │ Device A │◄────►│ Device B │
          │ (Laptop) │ WebRTC (Phone)  │
          └──────────┘DataChannel──────┘
                   (P2P File Data)
```

- **DataChannel Chunking**: Files are chunked into 64 KB frames with backpressure flow control (`bufferedAmount` & `bufferedAmountLowThreshold`).
- **File Assembly**: Chunks are reassembled into native `Blob`s on the receiving device with SHA-256 integrity verification.

---

## Automated Tests

Run the full signaling, room logic, multi-peer, and reliability test suite:

```bash
npm run test:server
```

Test cases covered:
- [x] Unique 6-digit pairing code generation
- [x] Room creation with creator role
- [x] Invalid code rejection
- [x] Non-existent room handling
- [x] Join room with joiner role
- [x] Enforce room limit (rejected with `ROOM_FULL`)
- [x] Peer discovery and message routing
- [x] Targeted signaling in multi-peer mesh rooms
- [x] Peer disconnection and notification
- [x] Automatic room cleanup on peer leave
- [x] Ping/pong round-trip latency measurement with correlation IDs
- [x] Message deduplication preventing duplicate operations
- [x] Signal delivery acknowledgments

---

## Known Platform & WebRTC Limitations

1. **Symmetric NATs / Strict Enterprise Firewalls**: CrossDrop uses standard public STUN servers (`stun:stun.l.google.com:19302`). Networks that block direct P2P UDP or implement symmetric NAT without hairpinned endpoints require a TURN relay server.
2. **Web Bluetooth in Browsers**: Ordinary browser-to-browser BLE file sharing is not supported by standard browser Web Bluetooth (GATT Central only). High-speed Wi-Fi P2P via WebRTC is the primary transport.
3. **Session Lifetime**: Rooms are strictly ephemeral and are automatically cleared when peers disconnect or after 30 minutes of inactivity.

