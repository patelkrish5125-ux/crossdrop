export type ConnectionState =
  | 'DISCONNECTED'
  | 'CONNECTING'
  | 'WAKING'
  | 'SIGNALING_CONNECTED'
  | 'WAITING_FOR_PEER'
  | 'NEGOTIATING'
  | 'CONNECTED'
  | 'TRANSFERRING'
  | 'COMPLETED'
  | 'RECONNECTING'
  | 'ERROR';

export type TransferStatus =
  | 'idle'
  | 'waiting'
  | 'preparing'
  | 'sending'
  | 'receiving'
  | 'transferring'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type PeerPresenceStatus = 'connected' | 'connecting' | 'disconnected';

export interface RemotePeer {
  id: string;
  name: string;
  role: 'creator' | 'joiner';
  status: PeerPresenceStatus;
  connectionState?: ConnectionState;
}

export interface PeerDevice {
  id?: string;
  name: string;
  platform?: string;
}

export interface FileMetadata {
  id: string;
  transferId: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  fileIndex: number;
  totalFiles: number;
  relativePath?: string;
  sha256?: string;
}

export interface TransferQueueItem {
  id: string;
  transferId: string;
  file?: File;
  name: string;
  size: number;
  mimeType: string;
  relativePath?: string;
  direction: 'send' | 'receive';
  targetPeerId?: string;
  targetPeerName?: string;
  status: TransferStatus;
  transferredBytes: number;
  percentage: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  error?: string;
  sha256?: string;
  integrityVerified?: boolean | null;
  canResume?: boolean;
  receivedBlob?: Blob;
  downloadUrl?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface TransferProgress {
  status: TransferStatus;
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  transferredBytes: number;
  totalBytes: number;
  percentage: number;
  overallTransferredBytes: number;
  overallTotalBytes: number;
  overallPercentage: number;
  speedBytesPerSec: number;
  etaSeconds: number | null;
  error?: string;
}

export interface ReceivedFile {
  id: string;
  transferId?: string;
  name: string;
  size: number;
  mimeType: string;
  relativePath?: string;
  blob: Blob;
  url: string;
  receivedAt: number;
  senderName?: string;
  sha256?: string;
  integrityVerified?: boolean | null;
}

export interface SessionHistoryItem {
  id: string;
  fileName: string;
  size: number;
  direction: 'sent' | 'received';
  peerName: string;
  speedBytesPerSec: number;
  durationMs: number;
  timestamp: number;
  integrityVerified: boolean;
}

export type SignalingServerMessage =
  | { type: 'room-created'; roomId: string; code: string; peerId?: string }
  | { type: 'room-joined'; roomId: string; code: string; peerId?: string; role: 'joiner'; peers?: Array<{ id: string; name: string; role: 'creator' | 'joiner' }> }
  | { type: 'peer-joined'; peer?: { id: string; name: string; role: 'creator' | 'joiner' }; role?: 'peer' }
  | { type: 'signal'; senderPeerId?: string; signalData: any }
  | { type: 'peer-left'; peerId: string; reason?: string }
  | { type: 'peer-disconnected'; peerId?: string; reason?: string }
  | { type: 'error'; code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'INVALID_CODE' | 'INVALID_MESSAGE'; message: string };

export type SignalingClientMessage =
  | { type: 'create-room'; deviceName?: string }
  | { type: 'join-room'; code: string; deviceName?: string }
  | { type: 'signal'; targetPeerId?: string; signalData: any }
  | { type: 'leave-room' };
