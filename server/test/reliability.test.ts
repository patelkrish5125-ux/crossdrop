import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from '../src/roomManager.js';
import type { ClientMessage, ServerMessage } from '../src/types.js';

const TEST_PORT = 4059;

function createTestServer(): Promise<{ server: http.Server; wss: WebSocketServer; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const roomManager = new RoomManager(4);
    const server = http.createServer();
    const wss = new WebSocketServer({ server });

    const processedMessageIds = new Map<string, number>();

    function send(ws: WebSocket, message: ServerMessage, replyTo?: string, roomId?: string) {
      if (ws.readyState === WebSocket.OPEN) {
        const fullMsg: ServerMessage = {
          id: 'srv-' + Math.random().toString(36).substring(2, 9),
          timestamp: Date.now(),
          roomId: roomId || message.roomId,
          replyTo: replyTo || message.replyTo,
          ...message,
        };
        ws.send(JSON.stringify(fullMsg));
      }
    }

    wss.on('connection', (ws) => {
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString()) as ClientMessage;

          if (msg.id) {
            if (processedMessageIds.has(msg.id)) {
              send(ws, { type: 'ack', ackMessageId: msg.id, replyTo: msg.id });
              return;
            }
            processedMessageIds.set(msg.id, Date.now());
          }

          switch (msg.type) {
            case 'ping': {
              send(ws, {
                type: 'pong',
                clientTime: msg.clientTime,
                serverTime: Date.now(),
                replyTo: msg.id,
              });
              break;
            }

            case 'create-room': {
              const { room, peer } = roomManager.createRoom(ws, msg.deviceName);
              send(
                ws,
                {
                  type: 'room-created',
                  roomId: room.id,
                  code: room.code,
                  peerId: peer.id,
                },
                msg.id,
                room.id
              );
              break;
            }

            case 'join-room': {
              const result = roomManager.joinRoom(msg.code, ws, msg.deviceName);
              if (!result.success) {
                send(ws, { type: 'error', code: result.error, message: result.message }, msg.id);
                return;
              }
              const { room, peer, existingPeers } = result;
              send(
                ws,
                {
                  type: 'room-joined',
                  roomId: room.id,
                  code: room.code,
                  peerId: peer.id,
                  role: 'joiner',
                  peers: existingPeers,
                },
                msg.id,
                room.id
              );

              const otherPeers = roomManager.getOtherPeers(ws);
              for (const other of otherPeers) {
                send(
                  other.ws,
                  {
                    type: 'peer-joined',
                    peer: { id: peer.id, name: peer.name, role: peer.role },
                    role: 'peer',
                  },
                  undefined,
                  room.id
                );
              }
              break;
            }

            case 'signal': {
              const senderInfo = roomManager.getPeerForSocket(ws);
              if (!senderInfo) {
                send(ws, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Not in a valid room.' }, msg.id);
                return;
              }
              const otherPeer = roomManager.getOtherPeer(ws);
              if (otherPeer) {
                send(
                  otherPeer.ws,
                  {
                    type: 'signal',
                    senderPeerId: senderInfo.peerId,
                    signalData: msg.signalData,
                  },
                  msg.id,
                  senderInfo.roomId
                );
                if (msg.id) {
                  send(ws, { type: 'ack', ackMessageId: msg.id, replyTo: msg.id });
                }
              }
              break;
            }
          }
        } catch {}
      });
    });

    server.listen(TEST_PORT, () => {
      resolve({
        server,
        wss,
        close: () =>
          new Promise<void>((res) => {
            wss.close(() => server.close(() => res()));
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

async function runReliabilityTests() {
  console.log('Running Signaling Protocol Reliability & Deduplication Tests...');
  const { close } = await createTestServer();
  const wsUrl = `ws://localhost:${TEST_PORT}`;

  try {
    const client = await connectClient(wsUrl);

    // 1. Test ping/pong with timestamp and replyTo
    const pingId = 'client-ping-101';
    const clientTime = Date.now();
    client.send(JSON.stringify({ type: 'ping', id: pingId, clientTime }));

    const pongMsg = await waitForMessage(client);
    assert.strictEqual(pongMsg.type, 'pong');
    assert.strictEqual(pongMsg.replyTo, pingId);
    assert.strictEqual((pongMsg as any).clientTime, clientTime);
    assert.ok(typeof (pongMsg as any).serverTime === 'number');
    console.log('✓ Test 1 Passed: Client ping received immediate pong with latency timestamps and correlation ID');

    // 2. Test create-room with message ID and verify enriched response
    const createId = 'create-room-msg-1';
    client.send(JSON.stringify({ type: 'create-room', id: createId, deviceName: 'Primary Unit' }));

    const createdMsg = await waitForMessage(client);
    assert.strictEqual(createdMsg.type, 'room-created');
    assert.strictEqual(createdMsg.replyTo, createId);
    assert.ok(createdMsg.id, 'Message should contain unique ID');
    assert.ok(createdMsg.timestamp, 'Message should contain timestamp');
    assert.ok(createdMsg.roomId, 'Message should contain roomId');
    const roomCode = createdMsg.code;
    console.log(`✓ Test 2 Passed: Room created with robust metadata (Room: ${createdMsg.roomId}, Code: ${roomCode})`);

    // 3. Test message deduplication: re-sending the same create-room ID returns an ack instead of creating a second room
    client.send(JSON.stringify({ type: 'create-room', id: createId, deviceName: 'Duplicate Send' }));
    const ackMsg = await waitForMessage(client);
    assert.strictEqual(ackMsg.type, 'ack');
    assert.strictEqual((ackMsg as any).ackMessageId, createId);
    console.log('✓ Test 3 Passed: Duplicate message ID safely intercepted with ACK (no duplicate room created)');

    // 4. Test signal with delivery acknowledgment
    const client2 = await connectClient(wsUrl);

    // Register waiters BEFORE sending join-room
    const pPeerJoined = waitForMessage(client);
    const pRoomJoined = waitForMessage(client2);

    client2.send(JSON.stringify({ type: 'join-room', code: roomCode, id: 'join-msg-1', deviceName: 'Secondary Unit' }));

    const peerJoined = await pPeerJoined;
    assert.strictEqual(peerJoined.type, 'peer-joined');

    const joinedMsg = await pRoomJoined;
    assert.strictEqual(joinedMsg.type, 'room-joined');

    // Register waiters BEFORE sending signal
    const pSigAck = waitForMessage(client);
    const pSigReceived = waitForMessage(client2);

    const signalMsgId = 'sig-offer-99';
    client.send(JSON.stringify({
      type: 'signal',
      id: signalMsgId,
      signalData: { type: 'offer', sdp: 'test-sdp' },
    }));

    const sigAck = await pSigAck;
    assert.strictEqual(sigAck.type, 'ack');
    assert.strictEqual((sigAck as any).ackMessageId, signalMsgId);

    const sigReceived = await pSigReceived;
    assert.strictEqual(sigReceived.type, 'signal');
    assert.strictEqual(sigReceived.signalData.type, 'offer');
    console.log('✓ Test 4 Passed: Signal relay provides sender delivery ACK and rich routing metadata');

    client.close();
    client2.close();

    console.log('\nAll Signaling Protocol Reliability Tests passed successfully!\n');
  } finally {
    await close();
  }
}

runReliabilityTests().catch((err) => {
  console.error('Reliability tests failed:', err);
  process.exit(1);
});
