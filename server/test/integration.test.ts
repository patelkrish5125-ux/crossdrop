import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from '../src/roomManager.js';
import type { ClientMessage, ServerMessage } from '../src/types.js';

const TEST_PORT = 4055;

function createTestServer(): Promise<{ server: http.Server; wss: WebSocketServer; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const roomManager = new RoomManager(2);
    const server = http.createServer();
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

async function runIntegrationTests() {
  console.log('Starting full signaling integration test...');
  const { close } = await createTestServer();
  const wsUrl = `ws://localhost:${TEST_PORT}`;

  try {
    // 1. Client A connects and creates room
    const clientA = await connectClient(wsUrl);
    clientA.send(JSON.stringify({ type: 'create-room' }));
    const msgCreated = await waitForMessage(clientA);
    assert.equal(msgCreated.type, 'room-created');
    if (msgCreated.type !== 'room-created') return;
    const roomCode = msgCreated.code;
    console.log(`✓ Client A created room with code ${roomCode}`);

    // 2. Client B tests invalid code
    const clientB = await connectClient(wsUrl);
    clientB.send(JSON.stringify({ type: 'join-room', code: '12' }));
    const msgInvalid = await waitForMessage(clientB);
    assert.equal(msgInvalid.type, 'error');
    if (msgInvalid.type === 'error') {
      assert.equal(msgInvalid.code, 'INVALID_CODE');
    }
    console.log('✓ Invalid code rejected with INVALID_CODE');

    // 3. Client B tests non-existent room code
    clientB.send(JSON.stringify({ type: 'join-room', code: '999999' }));
    const msgNotFound = await waitForMessage(clientB);
    assert.equal(msgNotFound.type, 'error');
    if (msgNotFound.type === 'error') {
      assert.equal(msgNotFound.code, 'ROOM_NOT_FOUND');
    }
    console.log('✓ Non-existent room rejected with ROOM_NOT_FOUND');

    // 4. Client B joins valid room
    const promiseA = waitForMessage(clientA);
    clientB.send(JSON.stringify({ type: 'join-room', code: roomCode }));
    const msgJoinedB = await waitForMessage(clientB);
    assert.equal(msgJoinedB.type, 'room-joined');

    const msgJoinedA = await promiseA;
    assert.equal(msgJoinedA.type, 'peer-joined');
    console.log('✓ Client B successfully joined room and Client A notified');

    // 5. Client C attempts to join full room
    const clientC = await connectClient(wsUrl);
    clientC.send(JSON.stringify({ type: 'join-room', code: roomCode }));
    const msgFull = await waitForMessage(clientC);
    assert.equal(msgFull.type, 'error');
    if (msgFull.type === 'error') {
      assert.equal(msgFull.code, 'ROOM_FULL');
    }
    console.log('✓ Client C rejected with ROOM_FULL');
    clientC.close();

    // 6. Signal relay: Client A sends offer -> Client B receives
    const promiseB_signal = waitForMessage(clientB);
    clientA.send(
      JSON.stringify({
        type: 'signal',
        signalData: { type: 'offer', sdp: 'mock-sdp-offer' },
      })
    );
    const msgSignalB = await promiseB_signal;
    assert.equal(msgSignalB.type, 'signal');
    if (msgSignalB.type === 'signal') {
      assert.equal(msgSignalB.signalData.sdp, 'mock-sdp-offer');
    }
    console.log('✓ Signaling data correctly relayed A -> B');

    // 7. Signal relay: Client B sends answer -> Client A receives
    const promiseA_signal = waitForMessage(clientA);
    clientB.send(
      JSON.stringify({
        type: 'signal',
        signalData: { type: 'answer', sdp: 'mock-sdp-answer' },
      })
    );
    const msgSignalA = await promiseA_signal;
    assert.equal(msgSignalA.type, 'signal');
    if (msgSignalA.type === 'signal') {
      assert.equal(msgSignalA.signalData.sdp, 'mock-sdp-answer');
    }
    console.log('✓ Signaling data correctly relayed B -> A');

    // 8. Client A disconnects -> Client B gets notified
    const promiseB_dc = waitForMessage(clientB);
    clientA.close();
    const msgDc = await promiseB_dc;
    assert.equal(msgDc.type, 'peer-disconnected');
    console.log('✓ Disconnection properly notified to remaining peer');

    clientB.close();
    console.log('\nAll end-to-end integration tests passed successfully!\n');
  } finally {
    await close();
  }
}

runIntegrationTests().catch((err) => {
  console.error('Integration test failed:', err);
  process.exit(1);
});
