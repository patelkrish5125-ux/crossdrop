import type { WebSocket } from 'ws';
import crypto from 'node:crypto';
import type { Room, RoomPeer, ServerMessage } from './types.js';

export class RoomManager {
  private roomsById = new Map<string, Room>();
  private roomIdByCode = new Map<string, string>();
  private peerMap = new Map<WebSocket, { peerId: string; roomId: string }>();

  /**
   * Generate a unique 6-digit room code
   */
  public generateCode(): string {
    let attempts = 0;
    while (attempts < 1000) {
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      if (!this.roomIdByCode.has(code)) {
        return code;
      }
      attempts++;
    }
    // Fallback using crypto random
    return crypto.randomInt(100000, 999999).toString();
  }

  /**
   * Create a new room with the requesting client as creator
   */
  public createRoom(ws: WebSocket): { room: Room; peer: RoomPeer } {
    // If the socket was in another room, remove it first
    this.removeSocket(ws);

    const roomId = crypto.randomUUID();
    const code = this.generateCode();
    const peerId = crypto.randomUUID();

    const peer: RoomPeer = {
      id: peerId,
      ws,
      role: 'creator',
    };

    const room: Room = {
      id: roomId,
      code,
      peers: [peer],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.roomsById.set(roomId, room);
    this.roomIdByCode.set(code, roomId);
    this.peerMap.set(ws, { peerId, roomId });

    return { room, peer };
  }

  /**
   * Join an existing room using a 6-digit code
   */
  public joinRoom(
    code: string,
    ws: WebSocket
  ): { success: true; room: Room; peer: RoomPeer } | { success: false; error: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'INVALID_CODE'; message: string } {
    const trimmedCode = code.trim();
    if (!/^\d{6}$/.test(trimmedCode)) {
      return {
        success: false,
        error: 'INVALID_CODE',
        message: 'Pairing code must be a 6-digit number.',
      };
    }

    const roomId = this.roomIdByCode.get(trimmedCode);
    if (!roomId) {
      return {
        success: false,
        error: 'ROOM_NOT_FOUND',
        message: 'No active room found with this pairing code.',
      };
    }

    const room = this.roomsById.get(roomId);
    if (!room) {
      this.roomIdByCode.delete(trimmedCode);
      return {
        success: false,
        error: 'ROOM_NOT_FOUND',
        message: 'No active room found with this pairing code.',
      };
    }

    // Phase 1 enforces exactly 2 devices per room
    if (room.peers.length >= 2) {
      return {
        success: false,
        error: 'ROOM_FULL',
        message: 'This room already has 2 devices connected.',
      };
    }

    // Remove socket from previous room if any
    this.removeSocket(ws);

    const peerId = crypto.randomUUID();
    const peer: RoomPeer = {
      id: peerId,
      ws,
      role: 'joiner',
    };

    room.peers.push(peer);
    room.lastActiveAt = Date.now();

    this.peerMap.set(ws, { peerId, roomId });

    return { success: true, room, peer };
  }

  /**
   * Get the other peer in the room
   */
  public getOtherPeer(ws: WebSocket): RoomPeer | null {
    const info = this.peerMap.get(ws);
    if (!info) return null;

    const room = this.roomsById.get(info.roomId);
    if (!room) return null;

    room.lastActiveAt = Date.now();
    return room.peers.find((p) => p.id !== info.peerId) || null;
  }

  /**
   * Get room info for a socket
   */
  public getRoomForSocket(ws: WebSocket): Room | null {
    const info = this.peerMap.get(ws);
    if (!info) return null;
    return this.roomsById.get(info.roomId) || null;
  }

  /**
   * Remove a socket when disconnected or leaving
   */
  public removeSocket(ws: WebSocket): { roomId?: string; notifiedPeer?: RoomPeer } {
    const info = this.peerMap.get(ws);
    if (!info) return {};

    this.peerMap.delete(ws);
    const room = this.roomsById.get(info.roomId);
    if (!room) return {};

    // Find remaining peer if any
    const remainingPeers = room.peers.filter((p) => p.id !== info.peerId);
    const notifiedPeer = remainingPeers[0] || undefined;

    room.peers = remainingPeers;
    room.lastActiveAt = Date.now();

    // If no peers left, delete room
    if (room.peers.length === 0) {
      this.roomsById.delete(room.id);
      this.roomIdByCode.delete(room.code);
    }

    return { roomId: room.id, notifiedPeer };
  }

  /**
   * Cleanup inactive rooms (older than 30 minutes)
   */
  public cleanupInactiveRooms(maxAgeMs = 30 * 60 * 1000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [roomId, room] of this.roomsById.entries()) {
      if (now - room.lastActiveAt > maxAgeMs) {
        // Disconnect any remaining sockets
        for (const peer of room.peers) {
          try {
            const msg: ServerMessage = {
              type: 'peer-disconnected',
              reason: 'Room expired due to inactivity.',
            };
            peer.ws.send(JSON.stringify(msg));
          } catch {
            // Ignore socket errors during cleanup
          }
          this.peerMap.delete(peer.ws);
        }
        this.roomsById.delete(roomId);
        this.roomIdByCode.delete(room.code);
        cleaned++;
      }
    }

    return cleaned;
  }

  public get activeRoomCount(): number {
    return this.roomsById.size;
  }
}
