export type ConnectionState =
  | 'Disconnected'
  | 'Connecting'
  | 'Connected'
  | 'Transferring'
  | 'Completed'
  | 'Error';

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
}

export interface TransferProgress {
  status: TransferStatus;
  fileName: string;
  transferredBytes: number;
  totalBytes: number;
  percentage: number;
  error?: string;
}

export interface ReceivedFile {
  name: string;
  size: number;
  mimeType: string;
  blob: Blob;
  url: string;
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
