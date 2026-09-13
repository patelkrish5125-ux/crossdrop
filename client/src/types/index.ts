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
  | 'preparing'
  | 'connecting'
  | 'sending'
  | 'receiving'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  totalChunks: number;
  chunkSize: number;
  fileIndex: number;
  totalFiles: number;
}

export interface FileTransferItem {
  id: string;
  name: string;
  size: number;
  status: TransferStatus;
  transferredBytes: number;
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
  name: string;
  size: number;
  mimeType: string;
  blob: Blob;
  url: string;
  receivedAt: number;
}

export interface PeerDevice {
  name: string;
  platform?: string;
}

export type SignalingServerMessage =
  | { type: 'room-created'; roomId: string; code: string }
  | { type: 'room-joined'; roomId: string; code: string; role: 'joiner' }
  | { type: 'peer-joined'; role: 'peer' }
  | { type: 'signal'; signalData: any }
  | { type: 'peer-disconnected'; reason?: string }
  | { type: 'error'; code: 'ROOM_NOT_FOUND' | 'ROOM_FULL' | 'INVALID_CODE' | 'INVALID_MESSAGE'; message: string };

export type SignalingClientMessage =
  | { type: 'create-room' }
  | { type: 'join-room'; code: string }
  | { type: 'signal'; signalData: any }
  | { type: 'leave-room' };
