import type { WebSocket } from 'ws';

export type ClientRole = 'creator' | 'joiner';

export interface RoomPeer {
  id: string;
  ws: WebSocket;
  role: ClientRole;
  name: string;
}

export interface PeerSummary {
  id: string;
  name: string;
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
  | { type: 'create-room'; deviceName?: string }
  | { type: 'join-room'; code: string; deviceName?: string }
  | { type: 'signal'; targetPeerId?: string; signalData: any }
  | { type: 'leave-room' };

// Server -> Client messages
export type ServerMessage =
  | { type: 'room-created'; roomId: string; code: string; peerId: string }
  | { type: 'room-joined'; roomId: string; code: string; peerId: string; role: 'joiner'; peers: PeerSummary[] }
  | { type: 'peer-joined'; peer: PeerSummary; role?: 'peer' }
  | { type: 'signal'; senderPeerId?: string; signalData: any }
  | { type: 'peer-left'; peerId: string; reason?: string }
  | { type: 'peer-disconnected'; peerId?: string; reason?: string }
  | { type: 'error'; code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'INVALID_CODE' | 'INVALID_MESSAGE'; message: string };
