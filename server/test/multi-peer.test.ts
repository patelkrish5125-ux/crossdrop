import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from '../src/roomManager.js';
import type { ClientMessage, ServerMessage } from '../src/types.js';

const TEST_PORT = 4057;

function createTestServer(): Promise<{ server: http.Server; wss: WebSocketServer; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const roomManager = new RoomManager(8); // Multi-device room support
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
              const { room, peer } = roomManager.createRoom(ws, msg.deviceName);
              send(ws, { type: 'room-created', roomId: room.id, code: room.code, peerId: peer.id });
              break;
            }
            case 'join-room': {
              const result = roomManager.joinRoom(msg.code, ws, msg.deviceName);
              if (!result.success) {
                send(ws, { type: 'error', code: result.error, message: result.message });
                return;
              }
              const { room, peer, existingPeers } = result;
              send(ws, {
                type: 'room-joined',
                roomId: room.id,
                code: room.code,
                peerId: peer.id,
                role: 'joiner',
                peers: existingPeers,
              });
              const peerSummary = { id: peer.id, name: peer.name, role: peer.role };
              const others = roomManager.getOtherPeers(ws);
              for (const other of others) {
                send(other.ws, { type: 'peer-joined', peer: peerSummary, role: 'peer' });
              }
              break;
            }
            case 'signal': {
              const senderInfo = roomManager.getPeerForSocket(ws);
              if (!senderInfo) return;
              if (msg.targetPeerId) {
                const target = roomManager.getPeerInRoom(senderInfo.roomId, msg.targetPeerId);
                if (target) {
                  send(target.ws, {
                    type: 'signal',
                    senderPeerId: senderInfo.peerId,
                    signalData: msg.signalData,
                  });
                }
              }
              break;
            }
            case 'leave-room': {
              const { leftPeerId, remainingPeers } = roomManager.removeSocket(ws);
              if (leftPeerId) {
                for (const r of remainingPeers) {
                  send(r.ws, { type: 'peer-left', peerId: leftPeerId, reason: 'Left room' });
                }
              }
              break;
            }
          }
        } catch {}
      });

      ws.on('close', () => {
        const { leftPeerId, remainingPeers } = roomManager.removeSocket(ws);
        if (leftPeerId) {
          for (const r of remainingPeers) {
            send(r.ws, { type: 'peer-left', peerId: leftPeerId, reason: 'Disconnected' });
          }
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

interface ClientHelper {
  ws: WebSocket;
  send(msg: ClientMessage): void;
  waitForType(type: string): Promise<any>;
}

function connectClientHelper(url: string): Promise<ClientHelper> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queue: ServerMessage[] = [];
    const waiters: { type: string; resolve: (msg: any) => void }[] = [];

    ws.on('open', () => {
      resolve({
        ws,
        send(msg: ClientMessage) {
          ws.send(JSON.stringify(msg));
        },
        waitForType(type: string): Promise<any> {
          const idx = queue.findIndex((m) => m.type === type);
          if (idx !== -1) {
            const found = queue.splice(idx, 1)[0];
            return Promise.resolve(found);
          }
          return new Promise((res) => {
            waiters.push({ type, resolve: res });
          });
        },
      });
    });

    ws.on('message', (data) => {
      const parsed = JSON.parse(data.toString());
      const wIdx = waiters.findIndex((w) => w.type === parsed.type);
      if (wIdx !== -1) {
        const waiter = waiters.splice(wIdx, 1)[0];
        waiter.resolve(parsed);
      } else {
        queue.push(parsed);
      }
    });

    ws.on('error', reject);
  });
}

async function runMultiPeerTests() {
  console.log('Running Multi-Peer Room Tests (Phase 3)...\n');
  const testServer = await createTestServer();
  const wsUrl = `ws://localhost:${TEST_PORT}`;

  try {
    // 1. Device 1 (Laptop) creates room
    const laptop = await connectClientHelper(wsUrl);
    laptop.send({ type: 'create-room', deviceName: 'Krish Laptop' });
    const createdMsg = await laptop.waitForType('room-created');
    const roomCode = createdMsg.code;
    const laptopPeerId = createdMsg.peerId;
    console.log(`✓ Device 1 (Krish Laptop) created room with code ${roomCode} (peerId: ${laptopPeerId})`);

    // 2. Device 2 (Phone 1) joins room
    const phone1 = await connectClientHelper(wsUrl);
    phone1.send({ type: 'join-room', code: roomCode, deviceName: 'Android Phone' });
    const phone1Joined = await phone1.waitForType('room-joined');
    assert.strictEqual(phone1Joined.peers.length, 1);
    assert.strictEqual(phone1Joined.peers[0].name, 'Krish Laptop');
    const phone1PeerId = phone1Joined.peerId;

    const laptopGotPeer1 = await laptop.waitForType('peer-joined');
    assert.strictEqual(laptopGotPeer1.peer.name, 'Android Phone');
    console.log(`✓ Device 2 (Android Phone) joined room. Laptop received peer-joined.`);

    // 3. Device 3 (Phone 2) joins room
    const phone2 = await connectClientHelper(wsUrl);
    phone2.send({ type: 'join-room', code: roomCode, deviceName: 'Work iPhone' });
    const phone2Joined = await phone2.waitForType('room-joined');
    assert.strictEqual(phone2Joined.peers.length, 2);
    const phone2PeerId = phone2Joined.peerId;

    const laptopGotPeer2 = await laptop.waitForType('peer-joined');
    const phone1GotPeer2 = await phone1.waitForType('peer-joined');
    assert.strictEqual(laptopGotPeer2.peer.name, 'Work iPhone');
    assert.strictEqual(phone1GotPeer2.peer.name, 'Work iPhone');
    console.log(`✓ Device 3 (Work iPhone) joined room. Both Laptop and Android Phone received peer-joined.`);

    // 4. Device 4 (Tablet) joins room
    const tablet = await connectClientHelper(wsUrl);
    tablet.send({ type: 'join-room', code: roomCode, deviceName: 'iPad Pro' });
    const tabletJoined = await tablet.waitForType('room-joined');
    assert.strictEqual(tabletJoined.peers.length, 3);
    const tabletPeerId = tabletJoined.peerId;
    console.log(`✓ Device 4 (iPad Pro) joined room. Now 4 devices in one room.`);

    // 5. Targeted Signal from Laptop to specific device (Work iPhone / Phone 2)
    laptop.send({
      type: 'signal',
      targetPeerId: phone2PeerId,
      signalData: { type: 'offer', sdp: 'targeted-laptop-to-iphone-sdp' },
    });
    const phone2GotSignal = await phone2.waitForType('signal');
    assert.strictEqual(phone2GotSignal.senderPeerId, laptopPeerId);
    assert.strictEqual(phone2GotSignal.signalData.sdp, 'targeted-laptop-to-iphone-sdp');
    console.log(`✓ Targeted signaling verified: Laptop signaled Work iPhone directly.`);

    // 6. Device departure notification
    tablet.ws.close();
    const leaveMsg = await laptop.waitForType('peer-left');
    assert.strictEqual(leaveMsg.peerId, tabletPeerId);
    console.log(`✓ Peer departure notification verified: Tablet left, remaining peers notified.`);

    laptop.ws.close();
    phone1.ws.close();
    phone2.ws.close();

    console.log('\nAll Multi-Peer Room Tests passed successfully!');
  } finally {
    await testServer.close();
  }
}

runMultiPeerTests().catch((err) => {
  console.error('Multi-peer test failed:', err);
  process.exit(1);
});
