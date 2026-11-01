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

// Signaling message base metadata
export interface SignalingMeta {
  id?: string;
  timestamp?: number;
  roomId?: string;
  senderPeerId?: string;
  targetPeerId?: string;
  replyTo?: string;
}

// Client -> Server messages
export type ClientMessage =
  | ({ type: 'create-room'; deviceName?: string } & SignalingMeta)
  | ({ type: 'join-room'; code: string; deviceName?: string } & SignalingMeta)
  | ({ type: 'signal'; targetPeerId?: string; signalData: any } & SignalingMeta)
  | ({ type: 'leave-room' } & SignalingMeta)
  | ({ type: 'ping'; clientTime?: number } & SignalingMeta)
  | ({ type: 'ack'; ackMessageId: string } & SignalingMeta);

// Server -> Client messages
export type ServerMessage =
  | ({ type: 'room-created'; roomId: string; code: string; peerId: string } & SignalingMeta)
  | ({ type: 'room-joined'; roomId: string; code: string; peerId: string; role: 'joiner'; peers: PeerSummary[] } & SignalingMeta)
  | ({ type: 'peer-joined'; peer: PeerSummary; role?: 'peer' } & SignalingMeta)
  | ({ type: 'signal'; senderPeerId?: string; signalData: any } & SignalingMeta)
  | ({ type: 'peer-left'; peerId: string; reason?: string } & SignalingMeta)
  | ({ type: 'peer-disconnected'; peerId?: string; reason?: string } & SignalingMeta)
  | ({ type: 'pong'; clientTime?: number; serverTime: number } & SignalingMeta)
  | ({ type: 'ack'; ackMessageId: string } & SignalingMeta)
  | ({ type: 'error'; code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'INVALID_CODE' | 'INVALID_MESSAGE' | 'DUPLICATE_MESSAGE'; message: string } & SignalingMeta);

