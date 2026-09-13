import assert from 'node:assert/strict';
import { RoomManager } from '../src/roomManager.js';

// Mock WebSocket
class MockWebSocket {
  public sent: string[] = [];
  public readyState = 1;
  public send(data: string) {
    this.sent.push(data);
  }
}

async function runTests() {
  console.log('Running RoomManager unit tests...');

  const rm = new RoomManager(2);

  // Test 1: Create Room
  const ws1 = new MockWebSocket() as any;
  const { room: room1, peer: peer1 } = rm.createRoom(ws1);
  assert.equal(room1.peers.length, 1);
  assert.equal(peer1.role, 'creator');
  assert.match(room1.code, /^\d{6}$/);
  console.log('✓ Test 1 Passed: Room created with 6-digit code:', room1.code);

  // Test 2: Invalid room code
  const ws2 = new MockWebSocket() as any;
  const invalidResult = rm.joinRoom('123', ws2);
  assert.equal(invalidResult.success, false);
  if (!invalidResult.success) {
    assert.equal(invalidResult.error, 'INVALID_CODE');
  }
  console.log('✓ Test 2 Passed: Invalid room code rejected');

  // Test 3: Non-existent room code
  const nonExistentResult = rm.joinRoom('999999', ws2);
  assert.equal(nonExistentResult.success, false);
  if (!nonExistentResult.success) {
    assert.equal(nonExistentResult.error, 'ROOM_NOT_FOUND');
  }
  console.log('✓ Test 3 Passed: Non-existent code returns ROOM_NOT_FOUND');

  // Test 4: Second peer joins room successfully
  const joinResult = rm.joinRoom(room1.code, ws2);
  assert.equal(joinResult.success, true);
  if (joinResult.success) {
    assert.equal(joinResult.peer.role, 'joiner');
    assert.equal(joinResult.room.peers.length, 2);
  }
  console.log('✓ Test 4 Passed: Second peer joined successfully');

  // Test 5: Third peer attempting to join is rejected with ROOM_FULL
  const ws3 = new MockWebSocket() as any;
  const thirdPeerResult = rm.joinRoom(room1.code, ws3);
  assert.equal(thirdPeerResult.success, false);
  if (!thirdPeerResult.success) {
    assert.equal(thirdPeerResult.error, 'ROOM_FULL');
  }
  console.log('✓ Test 5 Passed: Third peer rejected with ROOM_FULL');

  // Test 6: Get other peer
  const otherFromWs1 = rm.getOtherPeer(ws1);
  assert.equal(otherFromWs1?.ws, ws2);
  const otherFromWs2 = rm.getOtherPeer(ws2);
  assert.equal(otherFromWs2?.ws, ws1);
  console.log('✓ Test 6 Passed: Other peer correctly identified');

  // Test 7: Disconnect one peer notifies remaining peer
  const { notifiedPeer } = rm.removeSocket(ws1);
  assert.equal(notifiedPeer?.ws, ws2);
  const remainingRoom = rm.getRoomForSocket(ws2);
  assert.equal(remainingRoom?.peers.length, 1);
  console.log('✓ Test 7 Passed: Peer disconnect handled and other peer notified');

  // Test 8: Removing last peer deletes room
  rm.removeSocket(ws2);
  assert.equal(rm.activeRoomCount, 0);
  console.log('✓ Test 8 Passed: Room cleaned up when all peers leave');

  console.log('\nAll RoomManager tests passed successfully!\n');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
