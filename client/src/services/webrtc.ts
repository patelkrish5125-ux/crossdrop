import type {
  ConnectionState,
  FileMetadata,
  PeerDevice,
  ReceivedFile,
  TransferProgress,
} from '../types/index.ts';

const CHUNK_SIZE = 16384; // 16 KB safe chunk size across browsers
const BUFFER_THRESHOLD = 64 * 1024; // 64 KB threshold for backpressure

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

export interface WebRTCCallbacks {
  onConnectionStateChange?: (state: ConnectionState) => void;
  onProgress?: (progress: TransferProgress) => void;
  onFileReceived?: (file: ReceivedFile) => void;
  onError?: (error: string) => void;
  onPeerInfo?: (peer: PeerDevice) => void;
}

class TransferSpeedTracker {
  private lastTime = Date.now();
  private lastBytes = 0;
  private currentSpeed = 0;

  public reset(initialBytes = 0) {
    this.lastTime = Date.now();
    this.lastBytes = initialBytes;
    this.currentSpeed = 0;
  }

  public update(currentBytes: number, totalBytes: number): { speed: number; eta: number | null } {
    const now = Date.now();
    const elapsed = (now - this.lastTime) / 1000;

    if (elapsed >= 0.25) {
      const deltaBytes = Math.max(0, currentBytes - this.lastBytes);
      const instantSpeed = deltaBytes / elapsed;
      this.currentSpeed = this.currentSpeed === 0 ? instantSpeed : this.currentSpeed * 0.65 + instantSpeed * 0.35;
      this.lastTime = now;
      this.lastBytes = currentBytes;
    }

    const remainingBytes = Math.max(0, totalBytes - currentBytes);
    const eta = this.currentSpeed > 1000 ? Math.ceil(remainingBytes / this.currentSpeed) : null;
    return { speed: Math.max(0, Math.round(this.currentSpeed)), eta };
  }
}

export class WebRTCService {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private callbacks: WebRTCCallbacks = {};
  private sendSignalCallback: (signal: any) => void;
  private iceCandidatesQueue: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;

  private myDeviceName = 'Device';
  private isCancelled = false;

  // Receiving state
  private incomingMeta: FileMetadata | null = null;
  private incomingOverallTotalBytes = 0;
  private incomingOverallTransferredBytes = 0;
  private receivedChunks: ArrayBuffer[] = [];
  private receivedBytes = 0;
  private receiverSpeedTracker = new TransferSpeedTracker();

  constructor(sendSignal: (signal: any) => void, callbacks: WebRTCCallbacks = {}) {
    this.sendSignalCallback = sendSignal;
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: WebRTCCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public setDeviceName(name: string) {
    this.myDeviceName = name.trim() || 'Device';
    this.sendPeerInfo();
  }

  private sendPeerInfo() {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      try {
        this.dataChannel.send(
          JSON.stringify({
            type: 'peer-info',
            name: this.myDeviceName,
          })
        );
      } catch {}
    }
  }

  public initConnection(isInitiator: boolean) {
    this.cleanup();
    this.isRemoteDescriptionSet = false;
    this.iceCandidatesQueue = [];

    this.callbacks.onConnectionStateChange?.('NEGOTIATING');

    try {
      this.peerConnection = new RTCPeerConnection(RTC_CONFIG);

      this.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendSignalCallback({
            type: 'candidate',
            candidate: event.candidate.toJSON(),
          });
        }
      };

      this.peerConnection.onconnectionstatechange = () => {
        if (!this.peerConnection) return;
        const state = this.peerConnection.connectionState;
        console.log(`[WebRTC] PeerConnection state: ${state}`);

        if (state === 'connected') {
          if (this.dataChannel?.readyState === 'open') {
            this.callbacks.onConnectionStateChange?.('CONNECTED');
            this.sendPeerInfo();
          }
        } else if (state === 'disconnected') {
          this.callbacks.onConnectionStateChange?.('DISCONNECTED');
        } else if (state === 'failed') {
          this.callbacks.onConnectionStateChange?.('ERROR');
          this.callbacks.onError?.('P2P connection failed. Network may restrict direct connections.');
        } else if (state === 'closed') {
          this.callbacks.onConnectionStateChange?.('DISCONNECTED');
        }
      };

      this.peerConnection.oniceconnectionstatechange = () => {
        if (!this.peerConnection) return;
        console.log(`[WebRTC] ICE state: ${this.peerConnection.iceConnectionState}`);
        if (this.peerConnection.iceConnectionState === 'failed') {
          this.callbacks.onConnectionStateChange?.('ERROR');
          this.callbacks.onError?.('Network connection failed. Could not establish direct P2P connection.');
        }
      };

      if (isInitiator) {
        const dc = this.peerConnection.createDataChannel('file-transfer', {
          ordered: true,
        });
        this.setupDataChannel(dc);

        this.peerConnection
          .createOffer()
          .then((offer) => this.peerConnection!.setLocalDescription(offer))
          .then(() => {
            if (this.peerConnection?.localDescription) {
              this.sendSignalCallback({
                type: 'offer',
                sdp: this.peerConnection.localDescription,
              });
            }
          })
          .catch((err) => {
            console.error('[WebRTC] Create offer error:', err);
            this.callbacks.onConnectionStateChange?.('ERROR');
            this.callbacks.onError?.('Failed to initiate connection.');
          });
      } else {
        this.peerConnection.ondatachannel = (event) => {
          console.log('[WebRTC] Receiver got remote data channel');
          this.setupDataChannel(event.channel);
        };
      }
    } catch (err: any) {
      console.error('[WebRTC] Exception during PeerConnection setup:', err);
      this.callbacks.onConnectionStateChange?.('ERROR');
      this.callbacks.onError?.('Failed to initialize WebRTC subsystem: ' + err.message);
    }
  }

  private setupDataChannel(dc: RTCDataChannel) {
    this.dataChannel = dc;
    dc.binaryType = 'arraybuffer';

    dc.onopen = () => {
      console.log('[WebRTC] DataChannel open & ready for file transfer');
      this.callbacks.onConnectionStateChange?.('CONNECTED');
      this.sendPeerInfo();
    };

    dc.onclose = () => {
      console.log('[WebRTC] DataChannel closed');
      this.callbacks.onConnectionStateChange?.('DISCONNECTED');
    };

    dc.onerror = (event) => {
      console.error('[WebRTC] DataChannel error:', event);
      this.callbacks.onConnectionStateChange?.('ERROR');
      this.callbacks.onError?.('DataChannel error occurred during transfer.');
    };

    dc.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };
  }

  public async handleSignal(signalData: any) {
    if (!this.peerConnection) {
      console.warn('[WebRTC] Received signal but PeerConnection is not initialized.');
      return;
    }

    try {
      if (signalData.type === 'offer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        this.isRemoteDescriptionSet = true;
        await this.drainQueuedCandidates();

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        this.sendSignalCallback({
          type: 'answer',
          sdp: this.peerConnection.localDescription,
        });
      } else if (signalData.type === 'answer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        this.isRemoteDescriptionSet = true;
        await this.drainQueuedCandidates();
      } else if (signalData.type === 'candidate') {
        const candidate = new RTCIceCandidate(signalData.candidate);
        if (this.isRemoteDescriptionSet) {
          await this.peerConnection.addIceCandidate(candidate);
        } else {
          this.iceCandidatesQueue.push(signalData.candidate);
        }
      }
    } catch (err: any) {
      console.error('[WebRTC] Error handling signal message:', err);
      this.callbacks.onConnectionStateChange?.('ERROR');
      this.callbacks.onError?.('Signaling negotiation failed: ' + err.message);
    }
  }

  private async drainQueuedCandidates() {
    if (!this.peerConnection || !this.isRemoteDescriptionSet) return;
    while (this.iceCandidatesQueue.length > 0) {
      const candidateInit = this.iceCandidatesQueue.shift();
      if (candidateInit) {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidateInit)).catch((e) => {
          console.warn('[WebRTC] Failed to add queued ICE candidate:', e);
        });
      }
    }
  }

  /**
   * Transfer one or multiple files sequentially over RTCDataChannel.
   * Real-time transfer metrics (speed, ETA) are calculated per chunk.
   */
  public async sendFiles(files: File[]): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('P2P connection is not ready for transfer.');
    }
    if (files.length === 0) return;

    this.isCancelled = false;
    this.callbacks.onConnectionStateChange?.('TRANSFERRING');

    const totalFiles = files.length;
    const overallTotalBytes = files.reduce((acc, f) => acc + f.size, 0);
    let overallTransferredBytes = 0;

    const speedTracker = new TransferSpeedTracker();
    speedTracker.reset(0);

    for (let fileIndex = 0; fileIndex < totalFiles; fileIndex++) {
      if (this.isCancelled) break;

      const file = files[fileIndex];
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const metadata: FileMetadata = {
        id: `${Date.now()}-${fileIndex}-${Math.random().toString(36).substring(2, 7)}`,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        totalChunks,
        chunkSize: CHUNK_SIZE,
        fileIndex,
        totalFiles,
      };

      // 1. Send file metadata header
      this.dataChannel.send(
        JSON.stringify({
          type: 'file-meta',
          meta: metadata,
          overallTotalBytes,
          overallTransferredBytes,
        })
      );

      let offset = 0;
      let fileTransferredBytes = 0;

      while (offset < file.size) {
        if (this.isCancelled) {
          this.dataChannel.send(
            JSON.stringify({
              type: 'transfer-cancel',
              fileIndex,
            })
          );
          this.callbacks.onProgress?.({
            status: 'cancelled',
            fileName: file.name,
            fileIndex,
            totalFiles,
            transferredBytes: fileTransferredBytes,
            totalBytes: file.size,
            percentage: Math.round((fileTransferredBytes / Math.max(1, file.size)) * 100),
            overallTransferredBytes,
            overallTotalBytes,
            overallPercentage: Math.round((overallTransferredBytes / Math.max(1, overallTotalBytes)) * 100),
            speedBytesPerSec: 0,
            etaSeconds: null,
            error: 'Transfer cancelled by sender.',
          });
          this.callbacks.onConnectionStateChange?.('CONNECTED');
          return;
        }

        // Backpressure flow control
        if (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
          await this.waitForBufferDrain(this.dataChannel);
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const chunkBuffer = await slice.arrayBuffer();

        this.dataChannel.send(chunkBuffer);

        offset += CHUNK_SIZE;
        const sentChunk = Math.min(CHUNK_SIZE, file.size - fileTransferredBytes);
        fileTransferredBytes = Math.min(offset, file.size);
        overallTransferredBytes += sentChunk;

        const { speed, eta } = speedTracker.update(overallTransferredBytes, overallTotalBytes);

        this.callbacks.onProgress?.({
          status: 'sending',
          fileName: file.name,
          fileIndex,
          totalFiles,
          transferredBytes: fileTransferredBytes,
          totalBytes: file.size,
          percentage: Math.round((fileTransferredBytes / Math.max(1, file.size)) * 100),
          overallTransferredBytes,
          overallTotalBytes,
          overallPercentage: Math.round((overallTransferredBytes / Math.max(1, overallTotalBytes)) * 100),
          speedBytesPerSec: speed,
          etaSeconds: eta,
        });
      }

      if (this.isCancelled) break;

      // 2. Send file end marker
      this.dataChannel.send(
        JSON.stringify({
          type: 'file-end',
          id: metadata.id,
          fileIndex,
        })
      );

      this.callbacks.onProgress?.({
        status: fileIndex === totalFiles - 1 ? 'completed' : 'sending',
        fileName: file.name,
        fileIndex,
        totalFiles,
        transferredBytes: file.size,
        totalBytes: file.size,
        percentage: 100,
        overallTransferredBytes,
        overallTotalBytes,
        overallPercentage: Math.round((overallTransferredBytes / Math.max(1, overallTotalBytes)) * 100),
        speedBytesPerSec: 0,
        etaSeconds: 0,
      });
    }

    if (!this.isCancelled) {
      this.callbacks.onConnectionStateChange?.('COMPLETED');
    }
  }

  public cancelTransfer() {
    this.isCancelled = true;
  }

  private waitForBufferDrain(channel: RTCDataChannel): Promise<void> {
    return new Promise((resolve) => {
      const handleLow = () => {
        channel.removeEventListener('bufferedamountlow', handleLow);
        resolve();
      };
      channel.addEventListener('bufferedamountlow', handleLow);
    });
  }

  private handleIncomingMessage(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'peer-info') {
          if (msg.name) {
            this.callbacks.onPeerInfo?.({ name: msg.name });
          }
        } else if (msg.type === 'file-meta') {
          this.incomingMeta = msg.meta;
          this.incomingOverallTotalBytes = msg.overallTotalBytes || this.incomingMeta!.size;
          this.incomingOverallTransferredBytes = msg.overallTransferredBytes || 0;
          this.receivedChunks = [];
          this.receivedBytes = 0;
          this.receiverSpeedTracker.reset(this.incomingOverallTransferredBytes);

          this.callbacks.onConnectionStateChange?.('TRANSFERRING');
          this.callbacks.onProgress?.({
            status: 'receiving',
            fileName: this.incomingMeta!.name,
            fileIndex: this.incomingMeta!.fileIndex,
            totalFiles: this.incomingMeta!.totalFiles,
            transferredBytes: 0,
            totalBytes: this.incomingMeta!.size,
            percentage: 0,
            overallTransferredBytes: this.incomingOverallTransferredBytes,
            overallTotalBytes: this.incomingOverallTotalBytes,
            overallPercentage: Math.round(
              (this.incomingOverallTransferredBytes / Math.max(1, this.incomingOverallTotalBytes)) * 100
            ),
            speedBytesPerSec: 0,
            etaSeconds: null,
          });
        } else if (msg.type === 'file-end') {
          if (this.incomingMeta && this.receivedChunks.length > 0) {
            const blob = new Blob(this.receivedChunks, {
              type: this.incomingMeta.mimeType,
            });
            const url = URL.createObjectURL(blob);

            const receivedFile: ReceivedFile = {
              id: this.incomingMeta.id,
              name: this.incomingMeta.name,
              size: this.incomingMeta.size,
              mimeType: this.incomingMeta.mimeType,
              blob,
              url,
              receivedAt: Date.now(),
            };

            const isLast = this.incomingMeta.fileIndex === this.incomingMeta.totalFiles - 1;

            this.callbacks.onFileReceived?.(receivedFile);
            this.callbacks.onProgress?.({
              status: isLast ? 'completed' : 'receiving',
              fileName: this.incomingMeta.name,
              fileIndex: this.incomingMeta.fileIndex,
              totalFiles: this.incomingMeta.totalFiles,
              transferredBytes: this.incomingMeta.size,
              totalBytes: this.incomingMeta.size,
              percentage: 100,
              overallTransferredBytes: this.incomingOverallTransferredBytes,
              overallTotalBytes: this.incomingOverallTotalBytes,
              overallPercentage: isLast
                ? 100
                : Math.round(
                    (this.incomingOverallTransferredBytes / Math.max(1, this.incomingOverallTotalBytes)) * 100
                  ),
              speedBytesPerSec: 0,
              etaSeconds: 0,
            });

            if (isLast) {
              this.callbacks.onConnectionStateChange?.('COMPLETED');
            }

            // Clear chunk buffers for next file in queue
            this.incomingMeta = null;
            this.receivedChunks = [];
            this.receivedBytes = 0;
          }
        } else if (msg.type === 'transfer-cancel') {
          this.incomingMeta = null;
          this.receivedChunks = [];
          this.receivedBytes = 0;
          this.callbacks.onProgress?.({
            status: 'cancelled',
            fileName: 'Transfer',
            fileIndex: 0,
            totalFiles: 1,
            transferredBytes: 0,
            totalBytes: 0,
            percentage: 0,
            overallTransferredBytes: 0,
            overallTotalBytes: 0,
            overallPercentage: 0,
            speedBytesPerSec: 0,
            etaSeconds: null,
            error: 'Sender cancelled the transfer.',
          });
          this.callbacks.onConnectionStateChange?.('CONNECTED');
        }
      } catch (err) {
        console.error('[WebRTC] Error parsing DataChannel message:', err);
      }
    } else if (data instanceof ArrayBuffer) {
      if (!this.incomingMeta) return;

      this.receivedChunks.push(data);
      this.receivedBytes += data.byteLength;
      this.incomingOverallTransferredBytes += data.byteLength;

      const total = this.incomingMeta.size;
      const percentage = total > 0 ? Math.min(100, Math.round((this.receivedBytes / total) * 100)) : 100;
      const overallPercentage =
        this.incomingOverallTotalBytes > 0
          ? Math.min(100, Math.round((this.incomingOverallTransferredBytes / this.incomingOverallTotalBytes) * 100))
          : 100;

      const { speed, eta } = this.receiverSpeedTracker.update(
        this.incomingOverallTransferredBytes,
        this.incomingOverallTotalBytes
      );

      this.callbacks.onProgress?.({
        status: 'receiving',
        fileName: this.incomingMeta.name,
        fileIndex: this.incomingMeta.fileIndex,
        totalFiles: this.incomingMeta.totalFiles,
        transferredBytes: this.receivedBytes,
        totalBytes: total,
        percentage,
        overallTransferredBytes: this.incomingOverallTransferredBytes,
        overallTotalBytes: this.incomingOverallTotalBytes,
        overallPercentage,
        speedBytesPerSec: speed,
        etaSeconds: eta,
      });
    }
  }

  public cleanup() {
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }

    if (this.peerConnection) {
      try {
        this.peerConnection.close();
      } catch {}
      this.peerConnection = null;
    }

    this.incomingMeta = null;
    this.receivedChunks = [];
    this.receivedBytes = 0;
    this.iceCandidatesQueue = [];
    this.isRemoteDescriptionSet = false;
  }
}
