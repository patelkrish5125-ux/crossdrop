import type {
  ConnectionState,
  FileMetadata,
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
}

export class WebRTCService {
  private peerConnection: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private callbacks: WebRTCCallbacks = {};
  private sendSignalCallback: (signal: any) => void;
  private iceCandidatesQueue: RTCIceCandidateInit[] = [];
  private isRemoteDescriptionSet = false;

  // File sending state
  private isCancelled = false;

  // File receiving state
  private incomingMeta: FileMetadata | null = null;
  private receivedChunks: ArrayBuffer[] = [];
  private receivedBytes = 0;

  constructor(sendSignal: (signal: any) => void, callbacks: WebRTCCallbacks = {}) {
    this.sendSignalCallback = sendSignal;
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: WebRTCCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public initConnection(isInitiator: boolean) {
    this.cleanup();
    this.isRemoteDescriptionSet = false;
    this.iceCandidatesQueue = [];

    this.callbacks.onConnectionStateChange?.('Connecting');

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
          // If channel is already open or opens soon
          if (this.dataChannel?.readyState === 'open') {
            this.callbacks.onConnectionStateChange?.('Connected');
          }
        } else if (state === 'disconnected') {
          this.callbacks.onConnectionStateChange?.('Disconnected');
        } else if (state === 'failed') {
          this.callbacks.onConnectionStateChange?.('Error');
          this.callbacks.onError?.('P2P connection failed. Network may restrict direct connections.');
        } else if (state === 'closed') {
          this.callbacks.onConnectionStateChange?.('Disconnected');
        }
      };

      this.peerConnection.oniceconnectionstatechange = () => {
        if (!this.peerConnection) return;
        console.log(`[WebRTC] ICE state: ${this.peerConnection.iceConnectionState}`);
        if (this.peerConnection.iceConnectionState === 'failed') {
          this.callbacks.onConnectionStateChange?.('Error');
          this.callbacks.onError?.('Network connection failed. Could not establish P2P connection.');
        }
      };

      if (isInitiator) {
        // Initiator creates data channel and offer
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
            this.callbacks.onError?.('Failed to initiate connection.');
          });
      } else {
        // Joiner listens for data channel
        this.peerConnection.ondatachannel = (event) => {
          console.log('[WebRTC] Received remote data channel');
          this.setupDataChannel(event.channel);
        };
      }
    } catch (err: any) {
      console.error('[WebRTC] Error initializing connection:', err);
      this.callbacks.onError?.(err.message || 'Could not initialize WebRTC.');
    }
  }

  private setupDataChannel(channel: RTCDataChannel) {
    this.dataChannel = channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.bufferedAmountLowThreshold = BUFFER_THRESHOLD;

    this.dataChannel.onopen = () => {
      console.log('[WebRTC] DataChannel open');
      this.callbacks.onConnectionStateChange?.('Connected');
    };

    this.dataChannel.onclose = () => {
      console.log('[WebRTC] DataChannel closed');
      this.callbacks.onConnectionStateChange?.('Disconnected');
    };

    this.dataChannel.onerror = (err) => {
      console.error('[WebRTC] DataChannel error:', err);
      this.callbacks.onError?.('Data channel error occurred.');
    };

    this.dataChannel.onmessage = (event) => {
      this.handleIncomingMessage(event.data);
    };
  }

  public async handleSignal(signal: any) {
    if (!this.peerConnection) return;

    try {
      if (signal.type === 'offer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        this.isRemoteDescriptionSet = true;
        this.processQueuedCandidates();

        const answer = await this.peerConnection.createAnswer();
        await this.peerConnection.setLocalDescription(answer);

        this.sendSignalCallback({
          type: 'answer',
          sdp: this.peerConnection.localDescription,
        });
      } else if (signal.type === 'answer') {
        await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        this.isRemoteDescriptionSet = true;
        this.processQueuedCandidates();
      } else if (signal.type === 'candidate') {
        const candidate = new RTCIceCandidate(signal.candidate);
        if (this.isRemoteDescriptionSet) {
          await this.peerConnection.addIceCandidate(candidate);
        } else {
          this.iceCandidatesQueue.push(candidate);
        }
      }
    } catch (err: any) {
      console.error('[WebRTC] Error handling signal:', err);
      this.callbacks.onError?.('Failed to process connection signal.');
    }
  }

  private processQueuedCandidates() {
    if (!this.peerConnection) return;
    while (this.iceCandidatesQueue.length > 0) {
      const cand = this.iceCandidatesQueue.shift();
      if (cand) {
        this.peerConnection.addIceCandidate(cand).catch((err) => {
          console.warn('[WebRTC] Error adding queued ICE candidate:', err);
        });
      }
    }
  }

  /**
   * Transfer a file to the connected peer over RTCDataChannel
   */
  public async sendFile(file: File): Promise<void> {
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('Connection is not ready for transfer.');
    }

    this.isCancelled = false;
    this.callbacks.onConnectionStateChange?.('Transferring');

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const metadata: FileMetadata = {
      id: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      chunkSize: CHUNK_SIZE,
    };

    this.callbacks.onProgress?.({
      status: 'preparing',
      fileName: file.name,
      transferredBytes: 0,
      totalBytes: file.size,
      percentage: 0,
    });

    // 1. Send file metadata header
    this.dataChannel.send(
      JSON.stringify({
        type: 'file-meta',
        meta: metadata,
      })
    );

    let offset = 0;
    let transferredBytes = 0;

    this.callbacks.onProgress?.({
      status: 'sending',
      fileName: file.name,
      transferredBytes: 0,
      totalBytes: file.size,
      percentage: 0,
    });

    // 2. Send chunks with backpressure handling
    while (offset < file.size) {
      if (this.isCancelled) {
        this.dataChannel.send(
          JSON.stringify({
            type: 'transfer-cancel',
            id: metadata.id,
          })
        );
        this.callbacks.onProgress?.({
          status: 'cancelled',
          fileName: file.name,
          transferredBytes,
          totalBytes: file.size,
          percentage: Math.round((transferredBytes / file.size) * 100),
        });
        this.callbacks.onConnectionStateChange?.('Connected');
        return;
      }

      // Check backpressure
      if (this.dataChannel.bufferedAmount > BUFFER_THRESHOLD) {
        await this.waitForBufferDrain(this.dataChannel);
      }

      const slice = file.slice(offset, offset + CHUNK_SIZE);
      const chunkBuffer = await slice.arrayBuffer();

      this.dataChannel.send(chunkBuffer);

      offset += CHUNK_SIZE;
      transferredBytes = Math.min(offset, file.size);

      this.callbacks.onProgress?.({
        status: 'sending',
        fileName: file.name,
        transferredBytes,
        totalBytes: file.size,
        percentage: Math.round((transferredBytes / file.size) * 100),
      });
    }

    // 3. Send file completion notification
    this.dataChannel.send(
      JSON.stringify({
        type: 'file-end',
        id: metadata.id,
      })
    );

    this.callbacks.onProgress?.({
      status: 'completed',
      fileName: file.name,
      transferredBytes: file.size,
      totalBytes: file.size,
      percentage: 100,
    });

    this.callbacks.onConnectionStateChange?.('Completed');
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

  /**
   * Handle incoming messages on the RTCDataChannel
   */
  private handleIncomingMessage(data: string | ArrayBuffer) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'file-meta') {
          this.incomingMeta = msg.meta;
          this.receivedChunks = [];
          this.receivedBytes = 0;
          this.callbacks.onConnectionStateChange?.('Transferring');
          this.callbacks.onProgress?.({
            status: 'receiving',
            fileName: this.incomingMeta!.name,
            transferredBytes: 0,
            totalBytes: this.incomingMeta!.size,
            percentage: 0,
          });
        } else if (msg.type === 'file-end') {
          if (this.incomingMeta && this.receivedChunks.length > 0) {
            const blob = new Blob(this.receivedChunks, {
              type: this.incomingMeta.mimeType,
            });
            const url = URL.createObjectURL(blob);

            const receivedFile: ReceivedFile = {
              name: this.incomingMeta.name,
              size: this.incomingMeta.size,
              mimeType: this.incomingMeta.mimeType,
              blob,
              url,
            };

            this.callbacks.onProgress?.({
              status: 'completed',
              fileName: this.incomingMeta.name,
              transferredBytes: this.incomingMeta.size,
              totalBytes: this.incomingMeta.size,
              percentage: 100,
            });

            this.callbacks.onFileReceived?.(receivedFile);
            this.callbacks.onConnectionStateChange?.('Completed');

            // Reset state
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
            transferredBytes: 0,
            totalBytes: 0,
            percentage: 0,
            error: 'Sender cancelled the transfer.',
          });
          this.callbacks.onConnectionStateChange?.('Connected');
        }
      } catch (err) {
        console.error('[WebRTC] Error parsing DataChannel string payload:', err);
      }
    } else if (data instanceof ArrayBuffer) {
      if (!this.incomingMeta) return;

      this.receivedChunks.push(data);
      this.receivedBytes += data.byteLength;

      const total = this.incomingMeta.size;
      const percentage = total > 0 ? Math.min(100, Math.round((this.receivedBytes / total) * 100)) : 100;

      this.callbacks.onProgress?.({
        status: 'receiving',
        fileName: this.incomingMeta.name,
        transferredBytes: this.receivedBytes,
        totalBytes: total,
        percentage,
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
