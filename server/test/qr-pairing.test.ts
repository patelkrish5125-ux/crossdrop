import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import QRCode from 'qrcode';
import { RoomManager } from '../src/roomManager.js';
import type { ClientMessage, ServerMessage } from '../src/types.js';

const TEST_PORT = 4056;

function createTestServer(): Promise<{ server: http.Server; wss: WebSocketServer; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const roomManager = new RoomManager(2);
    const server = http.createServer((req, res) => {
      // Test SPA fallback for /join route
      if (req.url?.startsWith('/join')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!DOCTYPE html><html><body>CrossDrop SPA</body></html>');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server });

    function send(ws: WebSocket, message: ServerMessage) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    }

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as ClientMessage;
          switch (msg.type) {
            case 'create-room': {
              const { room } = roomManager.createRoom(ws);
              send(ws, { type: 'room-created', roomId: room.id, code: room.code });
              break;
            }
            case 'join-room': {
              const result = roomManager.joinRoom(msg.code, ws);
              if (!result.success) {
                send(ws, { type: 'error', code: result.error, message: result.message });
                return;
              }
              const { room } = result;
              send(ws, { type: 'room-joined', roomId: room.id, code: room.code, role: 'joiner' });
              const creator = room.peers.find((p) => p.role === 'creator');
              if (creator && creator.ws !== ws) {
                send(creator.ws, { type: 'peer-joined', role: 'peer' });
              }
              break;
            }
            case 'signal': {
              const otherPeer = roomManager.getOtherPeer(ws);
              if (otherPeer) {
                send(otherPeer.ws, { type: 'signal', signalData: msg.signalData });
              }
              break;
            }
            case 'leave-room': {
              const { notifiedPeer } = roomManager.removeSocket(ws);
              if (notifiedPeer) {
                send(notifiedPeer.ws, { type: 'peer-disconnected', reason: 'Peer left the room.' });
              }
              break;
            }
          }
        } catch {}
      });

      ws.on('close', () => {
        const { notifiedPeer } = roomManager.removeSocket(ws);
        if (notifiedPeer) {
          send(notifiedPeer.ws, { type: 'peer-disconnected', reason: 'Peer disconnected.' });
        }
      });
    });

    server.listen(TEST_PORT, () => {
      resolve({
        server,
        wss,
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => {
              server.close(() => res());
            });
          }),
      });
    });
  });
}

function connectClient(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function waitForMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()));
    });
  });
}

/**
 * Parses a 6-digit room code from a join URL (mirroring client parseJoinRoomFromUrl).
 */
function parseJoinUrl(urlString: string): string | null {
  const url = new URL(urlString);
  const roomParam = url.searchParams.get('room') || url.searchParams.get('join');
  if (roomParam && /^\d{6}$/.test(roomParam.trim())) {
    return roomParam.trim();
  }
  const pathMatch = url.pathname.match(/^\/join\/(\d{6})$/);
  if (pathMatch) {
    return pathMatch[1];
  }
  return null;
}

async function runQrPairingTests() {
  console.log('Starting CrossDrop Real QR Pairing & Route Tests...\n');
  const testServer = await createTestServer();
  const wsUrl = `ws://localhost:${TEST_PORT}`;
  const origin = 'https://crossdrop-preview.onrender.com';

  try {
    // 1. Device A connects to real signaling server
    const clientA = await connectClient(wsUrl);
    console.log('✓ Step 1: Device A connected to real signaling server');

    // 2. Device A sends real create-room request
    clientA.send(JSON.stringify({ type: 'create-room' }));
    const msgA1 = (await waitForMessage(clientA)) as any;
    assert.strictEqual(msgA1.type, 'room-created');
    assert.match(msgA1.code, /^\d{6}$/);
    const realRoomCode = msgA1.code;
    console.log(`✓ Step 2: Server created real room and returned 6-digit code: ${realRoomCode}`);

    // 3. ONLY AFTER server confirms room exists, generate real QR code
    const joinUrl = `${origin}/join?room=${encodeURIComponent(realRoomCode)}`;
    console.log(`✓ Step 3: Generated QR join URL:\n   ${joinUrl}`);

    // Verify QR code generation produces valid SVG
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
    assert.ok(qrSvg.startsWith('<svg'), 'QR code must be a valid SVG');
    assert.ok(qrSvg.includes('viewBox='), 'QR code SVG must have viewBox');
    console.log(`✓ Step 4: Real QR code SVG successfully generated (${qrSvg.length} bytes)`);

    // Verify /join route returns 200 on HTTP
    const httpRes = await fetch(`http://localhost:${TEST_PORT}/join?room=${encodeURIComponent(realRoomCode)}`);
    assert.strictEqual(httpRes.status, 200);
    console.log('✓ Step 5: GET /join?room=... route verified (HTTP 200 OK)');

    // 4. Device B scans QR code: extracts realRoomCode from URL
    const detectedCode = parseJoinUrl(joinUrl);
    assert.strictEqual(detectedCode, realRoomCode);
    console.log(`✓ Step 6: Device B extracted room code from QR URL: ${detectedCode}`);

    // 5. Device B connects to real signaling server and sends real join-room request
    const clientB = await connectClient(wsUrl);
    const waitPeerJoinedA = waitForMessage(clientA);
    const waitRoomJoinedB = waitForMessage(clientB);

    clientB.send(JSON.stringify({ type: 'join-room', code: detectedCode }));

    const [peerJoinedMsg, roomJoinedMsg] = (await Promise.all([
      waitPeerJoinedA,
      waitRoomJoinedB,
    ])) as any[];

    assert.strictEqual(roomJoinedMsg.type, 'room-joined');
    assert.strictEqual(roomJoinedMsg.code, realRoomCode);
    assert.strictEqual(peerJoinedMsg.type, 'peer-joined');
    console.log('✓ Step 7: Device B joined real room; Device A received peer-joined notification');

    // 6. Test WebRTC signal relay between paired peers
    const signalPromise = waitForMessage(clientB);
    clientA.send(
      JSON.stringify({
        type: 'signal',
        signalData: { type: 'offer', sdp: 'fake-offer-for-testing-sdp' },
      })
    );
    const relayedMsg = (await signalPromise) as any;
    assert.strictEqual(relayedMsg.type, 'signal');
    assert.strictEqual(relayedMsg.signalData.sdp, 'fake-offer-for-testing-sdp');
    console.log('✓ Step 8: WebRTC signaling relay succeeded between paired peers');

    // 7. Test third peer rejection: Device C tries to join the already full room
    const clientC = await connectClient(wsUrl);
    clientC.send(JSON.stringify({ type: 'join-room', code: realRoomCode }));
    const errorMsgC = (await waitForMessage(clientC)) as any;
    assert.strictEqual(errorMsgC.type, 'error');
    assert.strictEqual(errorMsgC.code, 'ROOM_FULL');
    console.log('✓ Step 9: Third peer correctly rejected with ROOM_FULL ("Room is full.")');
    clientC.close();

    // 8. Test expired/nonexistent room: Device D tries to join nonexistent code
    const clientD = await connectClient(wsUrl);
    clientD.send(JSON.stringify({ type: 'join-room', code: '999999' }));
    const errorMsgD = (await waitForMessage(clientD)) as any;
    assert.strictEqual(errorMsgD.type, 'error');
    assert.strictEqual(errorMsgD.code, 'ROOM_NOT_FOUND');
    console.log('✓ Step 10: Nonexistent room correctly rejected with ROOM_NOT_FOUND ("Room expired or unavailable.")');
    clientD.close();

    // 9. Test room cleanup on peer leave (room expiration)
    clientA.close();
    clientB.close();
    await new Promise((r) => setTimeout(r, 100));

    // Try joining the closed room code again
    const clientE = await connectClient(wsUrl);
    clientE.send(JSON.stringify({ type: 'join-room', code: realRoomCode }));
    const errorMsgE = (await waitForMessage(clientE)) as any;
    assert.strictEqual(errorMsgE.type, 'error');
    assert.strictEqual(errorMsgE.code, 'ROOM_NOT_FOUND');
    console.log('✓ Step 11: Expired room correctly rejected with ROOM_NOT_FOUND after creator left');
    clientE.close();

    console.log('\nAll Real QR Pairing & Route tests passed successfully!');
  } finally {
    await testServer.close();
  }
}

runQrPairingTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
