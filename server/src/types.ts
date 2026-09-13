import type { WebSocket } from 'ws';

export type ClientRole = 'creator' | 'joiner';

export interface RoomPeer {
  id: string;
  ws: WebSocket;
  role: ClientRole;
}

export interface Room {
  id: string;
  code: string;
  peers: RoomPeer[];
  createdAt: number;
  lastActiveAt: number;
}

// Client -> Server messages
export type ClientMessage =
  | { type: 'create-room' }
  | { type: 'join-room'; code: string }
  | { type: 'signal'; signalData: any }
  | { type: 'leave-room' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'room-created'; roomId: string; code: string }
  | { type: 'room-joined'; roomId: string; code: string; role: 'joiner' }
  | { type: 'peer-joined'; role: 'peer' }
  | { type: 'signal'; signalData: any }
  | { type: 'peer-disconnected'; reason?: string }
  | { type: 'error'; code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'INVALID_CODE' | 'INVALID_MESSAGE'; message: string };
