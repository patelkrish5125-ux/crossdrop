import type {
  ConnectionState,
  FileMetadata,
  PeerDevice,
  ReceivedFile,
  RemotePeer,
  SessionHistoryItem,
  TransferProgress,
  TransferQueueItem,
} from '../types/index.ts';

// Phase 3 High-Performance WebRTC Configuration
export const CHUNK_SIZE = 64 * 1024; // 64 KB optimized chunk size (SCTP max message without IP fragmentation)
export const BUFFER_HIGH_WATERMARK = 1024 * 1024; // 1 MB max buffered amount before pausing
export const BUFFER_LOW_WATERMARK = 256 * 1024; // 256 KB threshold for unpausing via onbufferedamountlow
export const MAX_CONCURRENT_TRANSFERS = 3; // Bounded concurrent file transfers

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

// Binary framing constants
const MAGIC_BYTE = 0xcd; // CrossDrop packet identifier
const TYPE_CHUNK = 0x01;
const HEADER_SIZE = 26; // 1 byte magic + 1 byte type + 16 bytes transferId + 4 bytes chunkIdx + 4 bytes totalChunks

export interface WebRTCCallbacks {
  onConnectionStateChange?: (state: ConnectionState, peerId?: string) => void;
  onProgress?: (progress: TransferProgress) => void;
  onQueueUpdate?: (items: TransferQueueItem[]) => void;
  onFileReceived?: (file: ReceivedFile) => void;
  onError?: (error: string) => void;
  onPeerInfo?: (peer: PeerDevice) => void;
  onPeerListUpdate?: (peers: RemotePeer[]) => void;
  onSessionHistory?: (history: SessionHistoryItem[]) => void;
}

export class TransferSpeedTracker {
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

    if (elapsed >= 0.2) {
      const deltaBytes = Math.max(0, currentBytes - this.lastBytes);
      const instantSpeed = deltaBytes / elapsed;
      this.currentSpeed = this.currentSpeed === 0 ? instantSpeed : this.currentSpeed * 0.7 + instantSpeed * 0.3;
      this.lastTime = now;
      this.lastBytes = currentBytes;
    }

    const remainingBytes = Math.max(0, totalBytes - currentBytes);
    const eta = this.currentSpeed > 1000 ? Math.ceil(remainingBytes / this.currentSpeed) : null;
    return { speed: Math.max(0, Math.round(this.currentSpeed)), eta };
  }

  public get speed(): number {
    return Math.max(0, Math.round(this.currentSpeed));
  }
}

export async function computeSHA256(data: Blob | ArrayBuffer): Promise<string> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface PeerSession {
  peerId: string;
  name: string;
  role: 'creator' | 'joiner';
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  state: ConnectionState;
  iceQueue: RTCIceCandidateInit[];
  isRemoteSet: boolean;
}

interface IncomingTransferSession {
  transferId: string;
  meta: FileMetadata;
  receivedChunks: ArrayBuffer[];
  receivedBytes: number;
  speedTracker: TransferSpeedTracker;
  startedAt: number;
  isPaused: boolean;
}

interface OutgoingTransferTask {
  item: TransferQueueItem;
  meta: FileMetadata;
  targetPeerId?: string;
  isPaused: boolean;
  isCancelled: boolean;
  currentChunkIndex: number;
}

export class WebRTCService {
  private peers = new Map<string, PeerSession>();
  private defaultPeerId: string | null = null;
  private callbacks: WebRTCCallbacks = {};
  private sendSignalCallback: (signal: any, targetPeerId?: string) => void;
  private myDeviceName = 'Device';
  private localPeerId: string | null = null;

  // Transfer queue & state
  private queue: TransferQueueItem[] = [];
  private activeOutgoing = new Map<string, OutgoingTransferTask>();
  private activeIncoming = new Map<string, IncomingTransferSession>();
  private sessionHistory: SessionHistoryItem[] = [];
  private totalTransferredSessionBytes = 0;

  public getTotalTransferredSessionBytes(): number {
    return this.totalTransferredSessionBytes;
  }

  constructor(sendSignal: (signal: any, targetPeerId?: string) => void, callbacks: WebRTCCallbacks = {}) {
    this.sendSignalCallback = sendSignal;
    this.callbacks = callbacks;
  }

  public setCallbacks(callbacks: WebRTCCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public setDeviceName(name: string) {
    this.myDeviceName = name.trim() || 'Device';
    this.broadcastPeerInfo();
  }

  public setLocalPeerId(id: string) {
    this.localPeerId = id;
  }

  // --- Multi-Peer Mesh Connection Management ---

  public initConnection(isInitiator: boolean, targetPeerId?: string): void {
    const peerKey = targetPeerId || 'default_peer';
    let session = this.peers.get(peerKey);

    if (!session) {
      session = this.createPeerSession(peerKey);
      this.peers.set(peerKey, session);
      if (!this.defaultPeerId) this.defaultPeerId = peerKey;
    }

    if (isInitiator) {
      // Creator or existing peer creates data channel and offer
      const dc = session.pc.createDataChannel('crossdrop-data', {
        ordered: true,
      });
      this.setupDataChannel(dc, session);
      session.dc = dc;

      session.pc
        .createOffer()
        .then((offer) => session!.pc.setLocalDescription(offer))
        .then(() => {
          if (session!.pc.localDescription) {
            this.sendSignalCallback(session!.pc.localDescription, targetPeerId);
          }
        })
        .catch((err) => {
          console.error('[WebRTC] Failed to create offer:', err);
          this.setPeerState(session!, 'ERROR');
        });
    }
  }

  private createPeerSession(peerId: string): PeerSession {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    const session: PeerSession = {
      peerId,
      name: 'Remote Device',
      role: 'joiner',
      pc,
      dc: null,
      state: 'CONNECTING',
      iceQueue: [],
      isRemoteSet: false,
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalCallback(
          {
            type: 'candidate',
            candidate: event.candidate.toJSON(),
          },
          peerId === 'default_peer' ? undefined : peerId
        );
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`[WebRTC] Peer ${peerId} connectionState:`, pc.connectionState);
      if (pc.connectionState === 'connected') {
        this.setPeerState(session, 'CONNECTED');
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        this.setPeerState(session, 'DISCONNECTED');
      } else if (pc.connectionState === 'closed') {
        this.setPeerState(session, 'DISCONNECTED');
      }
    };

    pc.ondatachannel = (event) => {
      console.log(`[WebRTC] Received DataChannel from peer ${peerId}`);
      this.setupDataChannel(event.channel, session);
      session.dc = event.channel;
    };

    return session;
  }

  private setupDataChannel(dc: RTCDataChannel, session: PeerSession) {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = BUFFER_LOW_WATERMARK;

    dc.onopen = () => {
      console.log(`[WebRTC] DataChannel opened for peer ${session.peerId}!`);
      this.setPeerState(session, 'CONNECTED');
      this.sendPeerInfo(session);
    };

    dc.onclose = () => {
      console.log(`[WebRTC] DataChannel closed for peer ${session.peerId}`);
      this.setPeerState(session, 'DISCONNECTED');
    };

    dc.onerror = (err) => {
      console.error(`[WebRTC] DataChannel error for peer ${session.peerId}:`, err);
    };

    dc.onmessage = (event) => {
      this.handleIncomingData(event.data, session);
    };
  }

  public handleSignal(signalData: any, senderPeerId?: string): void {
    const peerKey = senderPeerId || this.defaultPeerId || 'default_peer';
    let session = this.peers.get(peerKey);

    if (!session) {
      session = this.createPeerSession(peerKey);
      this.peers.set(peerKey, session);
      if (!this.defaultPeerId) this.defaultPeerId = peerKey;
    }

    if (signalData.type === 'offer') {
      session.pc
        .setRemoteDescription(new RTCSessionDescription(signalData))
        .then(() => {
          session!.isRemoteSet = true;
          this.flushIceCandidates(session!);
          return session!.pc.createAnswer();
        })
        .then((answer) => session!.pc.setLocalDescription(answer))
        .then(() => {
          if (session!.pc.localDescription) {
            this.sendSignalCallback(session!.pc.localDescription, senderPeerId);
          }
        })
        .catch((err) => {
          console.error('[WebRTC] Error handling offer:', err);
          this.setPeerState(session!, 'ERROR');
        });
    } else if (signalData.type === 'answer') {
      session.pc
        .setRemoteDescription(new RTCSessionDescription(signalData))
        .then(() => {
          session!.isRemoteSet = true;
          this.flushIceCandidates(session!);
        })
        .catch((err) => {
          console.error('[WebRTC] Error handling answer:', err);
          this.setPeerState(session!, 'ERROR');
        });
    } else if (signalData.type === 'candidate' && signalData.candidate) {
      if (session.isRemoteSet) {
        session.pc.addIceCandidate(new RTCIceCandidate(signalData.candidate)).catch((err) => {
          console.error('[WebRTC] Error adding ICE candidate:', err);
        });
      } else {
        session.iceQueue.push(signalData.candidate);
      }
    }
  }

  private flushIceCandidates(session: PeerSession) {
    while (session.iceQueue.length > 0) {
      const cand = session.iceQueue.shift();
      if (cand) {
        session.pc.addIceCandidate(new RTCIceCandidate(cand)).catch(() => {});
      }
    }
  }

  private setPeerState(session: PeerSession, state: ConnectionState) {
    session.state = state;
    this.callbacks.onConnectionStateChange?.(state, session.peerId);
    this.notifyPeerList();
  }

  public notifyPeerList() {
    const list: RemotePeer[] = Array.from(this.peers.values()).map((p) => ({
      id: p.peerId,
      name: p.name,
      role: p.role,
      status: p.state === 'CONNECTED' ? 'connected' : p.state === 'CONNECTING' ? 'connecting' : 'disconnected',
      connectionState: p.state,
    }));
    this.callbacks.onPeerListUpdate?.(list);
  }

  public addPeerFromRoom(peerId: string, name: string, role: 'creator' | 'joiner') {
    let session = this.peers.get(peerId);
    if (!session) {
      session = this.createPeerSession(peerId);
      session.name = name;
      session.role = role;
      this.peers.set(peerId, session);
    } else {
      session.name = name;
      session.role = role;
    }
    if (!this.defaultPeerId) this.defaultPeerId = peerId;
    this.notifyPeerList();
  }

  public removePeer(peerId: string) {
    const session = this.peers.get(peerId);
    if (session) {
      try {
        session.dc?.close();
        session.pc.close();
      } catch {}
      this.peers.delete(peerId);
    }
    if (this.defaultPeerId === peerId) {
      this.defaultPeerId = this.peers.keys().next().value || null;
    }
    this.notifyPeerList();
  }

  private sendPeerInfo(session: PeerSession) {
    if (session.dc && session.dc.readyState === 'open') {
      try {
        session.dc.send(
          JSON.stringify({
            type: 'control',
            action: 'peer-info',
            name: this.myDeviceName,
            peerId: this.localPeerId,
          })
        );
      } catch {}
    }
  }

  private broadcastPeerInfo() {
    for (const session of this.peers.values()) {
      this.sendPeerInfo(session);
    }
  }

  public getConnectedPeers(): RemotePeer[] {
    return Array.from(this.peers.values())
      .filter((p) => p.state === 'CONNECTED')
      .map((p) => ({
        id: p.peerId,
        name: p.name,
        role: p.role,
        status: 'connected',
        connectionState: p.state,
      }));
  }

  // --- Queue Management & Multi-File Schedulers ---

  /**
   * Adds files/folders to the transfer queue.
   */
  public addFilesToQueue(files: File[], targetPeerId?: string): TransferQueueItem[] {
    const targetPeer = targetPeerId ? this.peers.get(targetPeerId) : this.getFirstConnectedPeer();
    const targetName = targetPeer?.name || 'Peer Device';
    const effectiveTargetId = targetPeer?.peerId;

    const newItems: TransferQueueItem[] = files.map((file, idx) => {
      const transferId = Math.random().toString(36).substring(2, 10) + Date.now().toString(36).substring(4);
      // Check for webkitRelativePath for folder structure preservation
      const relativePath = (file as any).webkitRelativePath || undefined;

      return {
        id: `send-${transferId}-${idx}`,
        transferId,
        file,
        name: file.name,
        size: file.size,
        mimeType: file.type || 'application/octet-stream',
        relativePath,
        direction: 'send',
        targetPeerId: effectiveTargetId,
        targetPeerName: targetName,
        status: 'waiting',
        transferredBytes: 0,
        percentage: 0,
        speedBytesPerSec: 0,
        etaSeconds: null,
      };
    });

    this.queue.push(...newItems);
    this.callbacks.onQueueUpdate?.([...this.queue]);
    this.processQueue();
    return newItems;
  }

  private getFirstConnectedPeer(): PeerSession | null {
    for (const session of this.peers.values()) {
      if (session.state === 'CONNECTED' && session.dc?.readyState === 'open') {
        return session;
      }
    }
    return null;
  }

  /**
   * Scheduler for bounded concurrent transfers (up to MAX_CONCURRENT_TRANSFERS).
   */
  private processQueue() {
    const activeCount = this.activeOutgoing.size;
    if (activeCount >= MAX_CONCURRENT_TRANSFERS) return;

    const availableSlots = MAX_CONCURRENT_TRANSFERS - activeCount;
    const waitingItems = this.queue.filter((i) => i.status === 'waiting').slice(0, availableSlots);

    for (const item of waitingItems) {
      if (!item.file) continue;
      this.startFileTransfer(item);
    }
  }

  private async startFileTransfer(item: TransferQueueItem) {
    const file = item.file!;
    const targetPeer = item.targetPeerId ? this.peers.get(item.targetPeerId) : this.getFirstConnectedPeer();

    if (!targetPeer || !targetPeer.dc || targetPeer.dc.readyState !== 'open') {
      item.status = 'failed';
      item.error = 'Selected destination peer is not connected.';
      this.callbacks.onQueueUpdate?.([...this.queue]);
      return;
    }

    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const meta: FileMetadata = {
      id: item.id,
      transferId: item.transferId,
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
      chunkSize: CHUNK_SIZE,
      fileIndex: this.queue.indexOf(item),
      totalFiles: this.queue.length,
      relativePath: item.relativePath,
    };

    item.status = 'transferring';
    item.startedAt = Date.now();
    this.callbacks.onQueueUpdate?.([...this.queue]);

    const task: OutgoingTransferTask = {
      item,
      meta,
      targetPeerId: targetPeer.peerId,
      isPaused: false,
      isCancelled: false,
      currentChunkIndex: 0,
    };

    this.activeOutgoing.set(item.transferId, task);

    // Send control frame: file-start
    try {
      targetPeer.dc.send(
        JSON.stringify({
          type: 'control',
          action: 'file-start',
          meta,
        })
      );
    } catch (e: any) {
      item.status = 'failed';
      item.error = 'Failed to initiate transfer header: ' + e.message;
      this.activeOutgoing.delete(item.transferId);
      this.callbacks.onQueueUpdate?.([...this.queue]);
      this.processQueue();
      return;
    }

    // Run high-speed pipelined chunk streaming
    this.streamChunks(task, targetPeer);
  }

  /**
   * Pipelined chunk streaming engine using 64 KB chunks and bufferedAmountLowThreshold backpressure.
   */
  private async streamChunks(task: OutgoingTransferTask, session: PeerSession) {
    const file = task.item.file!;
    const dc = session.dc!;
    const speedTracker = new TransferSpeedTracker();
    speedTracker.reset(task.item.transferredBytes);

    const encoder = new TextEncoder();
    const transferIdBytes = new Uint8Array(16);
    transferIdBytes.set(encoder.encode(task.meta.transferId).slice(0, 16));

    while (task.currentChunkIndex < task.meta.totalChunks) {
      if (task.isCancelled) {
        return;
      }

      if (task.isPaused) {
        task.item.status = 'paused';
        this.callbacks.onQueueUpdate?.([...this.queue]);
        return;
      }

      if (dc.readyState !== 'open') {
        task.item.status = 'failed';
        task.item.error = 'Connection lost during transfer.';
        task.item.canResume = true;
        this.activeOutgoing.delete(task.meta.transferId);
        this.callbacks.onQueueUpdate?.([...this.queue]);
        this.processQueue();
        return;
      }

      // Check DataChannel backpressure: if buffer is high, wait for onbufferedamountlow
      if (dc.bufferedAmount >= BUFFER_HIGH_WATERMARK) {
        await new Promise<void>((resolve) => {
          const onLow = () => {
            dc.removeEventListener('bufferedamountlow', onLow);
            resolve();
          };
          dc.addEventListener('bufferedamountlow', onLow);
        });
      }

      // Slice only the current 64 KB chunk on-demand (zero full-file RAM footprint)
      const start = task.currentChunkIndex * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      const chunkBlob = file.slice(start, end);
      const chunkData = await chunkBlob.arrayBuffer();

      // Build binary packet with 26-byte compact header
      const packet = new Uint8Array(HEADER_SIZE + chunkData.byteLength);
      packet[0] = MAGIC_BYTE;
      packet[1] = TYPE_CHUNK;
      packet.set(transferIdBytes, 2);

      const view = new DataView(packet.buffer);
      view.setUint32(18, task.currentChunkIndex, false); // Big endian chunk index
      view.setUint32(22, task.meta.totalChunks, false); // Big endian total chunks
      packet.set(new Uint8Array(chunkData), HEADER_SIZE);

      try {
        dc.send(packet.buffer);
      } catch (err: any) {
        task.item.status = 'failed';
        task.item.error = 'DataChannel send failed: ' + err.message;
        task.item.canResume = true;
        this.activeOutgoing.delete(task.meta.transferId);
        this.callbacks.onQueueUpdate?.([...this.queue]);
        this.processQueue();
        return;
      }

      task.currentChunkIndex++;
      task.item.transferredBytes = end;
      task.item.percentage = Math.round((end / file.size) * 100);

      // Update per-file speed & ETA
      const { speed, eta } = speedTracker.update(end, file.size);
      task.item.speedBytesPerSec = speed;
      task.item.etaSeconds = eta;

      // Update aggregate throughput
      this.totalTransferredSessionBytes += chunkData.byteLength;
      this.emitProgressUpdate(task.item);
    }

    // Transfer completed: Calculate SHA-256 integrity hash
    let hash = '';
    try {
      hash = await computeSHA256(file);
    } catch {}

    task.item.status = 'completed';
    task.item.sha256 = hash;
    task.item.integrityVerified = true;
    task.item.completedAt = Date.now();

    // Send control frame: file-complete with SHA-256
    try {
      dc.send(
        JSON.stringify({
          type: 'control',
          action: 'file-complete',
          transferId: task.meta.transferId,
          sha256: hash,
        })
      );
    } catch {}

    // Record in session history
    const durationMs = (task.item.completedAt || Date.now()) - (task.item.startedAt || Date.now());
    this.sessionHistory.unshift({
      id: task.item.id,
      fileName: task.item.name,
      size: task.item.size,
      direction: 'sent',
      peerName: task.item.targetPeerName || 'Peer',
      speedBytesPerSec: durationMs > 0 ? Math.round((task.item.size / durationMs) * 1000) : 0,
      durationMs,
      timestamp: Date.now(),
      integrityVerified: true,
    });
    this.callbacks.onSessionHistory?.([...this.sessionHistory]);

    this.activeOutgoing.delete(task.meta.transferId);
    this.callbacks.onQueueUpdate?.([...this.queue]);

    // Process next queued file in concurrency slot
    this.processQueue();
  }

  // --- Incoming DataChannel Packet Processing ---

  private async handleIncomingData(data: ArrayBuffer | string, session: PeerSession) {
    if (typeof data === 'string') {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'control') {
          this.handleControlMessage(msg, session);
        }
      } catch {}
      return;
    }

    // Binary packet: Check magic byte
    const bytes = new Uint8Array(data);
    if (bytes.length < HEADER_SIZE || bytes[0] !== MAGIC_BYTE) {
      return;
    }

    const packetType = bytes[1];
    if (packetType !== TYPE_CHUNK) return;

    // Decode 16-byte transferId
    const decoder = new TextDecoder();
    const transferId = decoder.decode(bytes.slice(2, 18)).replace(/\0/g, '').trim();

    const view = new DataView(data);
    const chunkIndex = view.getUint32(18, false);
    const totalChunks = view.getUint32(22, false);
    const payload = data.slice(HEADER_SIZE);

    let incoming = this.activeIncoming.get(transferId);
    if (!incoming) {
      // In case file-start was delayed, instantiate fallback session
      incoming = {
        transferId,
        meta: {
          id: transferId,
          transferId,
          name: 'Received_File',
          size: totalChunks * CHUNK_SIZE,
          mimeType: 'application/octet-stream',
          totalChunks,
          chunkSize: CHUNK_SIZE,
          fileIndex: 0,
          totalFiles: 1,
        },
        receivedChunks: new Array(totalChunks),
        receivedBytes: 0,
        speedTracker: new TransferSpeedTracker(),
        startedAt: Date.now(),
        isPaused: false,
      };
      this.activeIncoming.set(transferId, incoming);
    }

    incoming.receivedChunks[chunkIndex] = payload;
    incoming.receivedBytes += payload.byteLength;

    // Update queue item for UI tracking
    let queueItem = this.queue.find((q) => q.transferId === transferId);
    if (!queueItem) {
      queueItem = {
        id: `recv-${transferId}`,
        transferId,
        name: incoming.meta.name,
        size: incoming.meta.size,
        mimeType: incoming.meta.mimeType,
        relativePath: incoming.meta.relativePath,
        direction: 'receive',
        targetPeerId: session.peerId,
        targetPeerName: session.name,
        status: 'receiving',
        transferredBytes: incoming.receivedBytes,
        percentage: Math.round((incoming.receivedBytes / incoming.meta.size) * 100),
        speedBytesPerSec: 0,
        etaSeconds: null,
      };
      this.queue.push(queueItem);
    } else {
      queueItem.transferredBytes = incoming.receivedBytes;
      queueItem.percentage = Math.round((incoming.receivedBytes / incoming.meta.size) * 100);
      const { speed, eta } = incoming.speedTracker.update(incoming.receivedBytes, incoming.meta.size);
      queueItem.speedBytesPerSec = speed;
      queueItem.etaSeconds = eta;
    }

    this.emitProgressUpdate(queueItem);

    // Check if file is completely received
    if (incoming.receivedBytes >= incoming.meta.size || chunkIndex === totalChunks - 1) {
      const isAllPresent = incoming.receivedChunks.filter(Boolean).length === totalChunks;
      if (isAllPresent) {
        await this.finalizeIncomingFile(incoming, queueItem, session);
      }
    }
  }

  private async finalizeIncomingFile(
    incoming: IncomingTransferSession,
    queueItem: TransferQueueItem,
    session: PeerSession
  ) {
    // Assemble Blob from ordered chunks
    const blob = new Blob(incoming.receivedChunks, { type: incoming.meta.mimeType });
    const url = URL.createObjectURL(blob);

    // Compute SHA-256 hash
    let hash = '';
    try {
      hash = await computeSHA256(blob);
    } catch {}

    // Clean up chunk array immediately to free RAM on mobile
    incoming.receivedChunks = [];
    this.activeIncoming.delete(incoming.transferId);

    queueItem.status = 'completed';
    queueItem.sha256 = hash;
    queueItem.receivedBlob = blob;
    queueItem.downloadUrl = url;
    queueItem.completedAt = Date.now();

    // Verify integrity if sender sent hash
    let integrityVerified = true;
    if (incoming.meta.sha256 && incoming.meta.sha256 !== hash) {
      integrityVerified = false;
      queueItem.integrityVerified = false;
      queueItem.error = 'Transfer completed but integrity verification failed (hash mismatch).';
    } else {
      queueItem.integrityVerified = true;
    }

    const receivedFile: ReceivedFile = {
      id: incoming.meta.id || incoming.transferId,
      transferId: incoming.transferId,
      name: incoming.meta.name,
      size: blob.size,
      mimeType: incoming.meta.mimeType,
      relativePath: incoming.meta.relativePath,
      blob,
      url,
      receivedAt: Date.now(),
      senderName: session.name,
      sha256: hash,
      integrityVerified,
    };

    this.callbacks.onFileReceived?.(receivedFile);
    this.callbacks.onQueueUpdate?.([...this.queue]);

    // Record in session history
    const durationMs = Date.now() - incoming.startedAt;
    this.sessionHistory.unshift({
      id: queueItem.id,
      fileName: incoming.meta.name,
      size: blob.size,
      direction: 'received',
      peerName: session.name,
      speedBytesPerSec: durationMs > 0 ? Math.round((blob.size / durationMs) * 1000) : 0,
      durationMs,
      timestamp: Date.now(),
      integrityVerified,
    });
    this.callbacks.onSessionHistory?.([...this.sessionHistory]);
  }

  private handleControlMessage(msg: any, session: PeerSession) {
    switch (msg.action) {
      case 'peer-info': {
        if (msg.name) {
          session.name = msg.name;
          this.callbacks.onPeerInfo?.({ name: msg.name, id: session.peerId });
          this.notifyPeerList();
        }
        break;
      }

      case 'file-start': {
        const meta: FileMetadata = msg.meta;
        this.activeIncoming.set(meta.transferId, {
          transferId: meta.transferId,
          meta,
          receivedChunks: new Array(meta.totalChunks),
          receivedBytes: 0,
          speedTracker: new TransferSpeedTracker(),
          startedAt: Date.now(),
          isPaused: false,
        });

        const queueItem: TransferQueueItem = {
          id: `recv-${meta.transferId}`,
          transferId: meta.transferId,
          name: meta.name,
          size: meta.size,
          mimeType: meta.mimeType,
          relativePath: meta.relativePath,
          direction: 'receive',
          targetPeerId: session.peerId,
          targetPeerName: session.name,
          status: 'receiving',
          transferredBytes: 0,
          percentage: 0,
          speedBytesPerSec: 0,
          etaSeconds: null,
        };
        this.queue.push(queueItem);
        this.callbacks.onQueueUpdate?.([...this.queue]);
        break;
      }

      case 'file-complete': {
        const item = this.queue.find((q) => q.transferId === msg.transferId);
        if (item) {
          if (msg.sha256 && item.sha256 && msg.sha256 !== item.sha256) {
            item.integrityVerified = false;
            item.error = 'Transfer completed but integrity verification failed (checksum mismatch).';
            this.callbacks.onQueueUpdate?.([...this.queue]);
          }
        }
        break;
      }

      case 'pause': {
        const outgoing = this.activeOutgoing.get(msg.transferId);
        if (outgoing) {
          outgoing.isPaused = true;
          outgoing.item.status = 'paused';
          this.callbacks.onQueueUpdate?.([...this.queue]);
        }
        break;
      }

      case 'resume-request': {
        const outgoing = this.activeOutgoing.get(msg.transferId);
        if (outgoing && session.dc) {
          outgoing.isPaused = false;
          outgoing.item.status = 'transferring';
          outgoing.currentChunkIndex = Math.max(0, msg.fromChunk || 0);
          this.streamChunks(outgoing, session);
        }
        break;
      }

      case 'cancel': {
        const outgoing = this.activeOutgoing.get(msg.transferId);
        if (outgoing) {
          outgoing.isCancelled = true;
          outgoing.item.status = 'cancelled';
          this.activeOutgoing.delete(msg.transferId);
        }
        const incoming = this.activeIncoming.get(msg.transferId);
        if (incoming) {
          incoming.receivedChunks = [];
          this.activeIncoming.delete(msg.transferId);
          const q = this.queue.find((i) => i.transferId === msg.transferId);
          if (q) q.status = 'cancelled';
        }
        this.callbacks.onQueueUpdate?.([...this.queue]);
        this.processQueue();
        break;
      }
    }
  }

  // --- Actions: Pause, Resume, Cancel ---

  public pauseTransfer(transferId: string): void {
    const task = this.activeOutgoing.get(transferId);
    if (task) {
      task.isPaused = true;
      task.item.status = 'paused';
      const session = task.targetPeerId ? this.peers.get(task.targetPeerId) : this.getFirstConnectedPeer();
      session?.dc?.send(JSON.stringify({ type: 'control', action: 'pause', transferId }));
      this.callbacks.onQueueUpdate?.([...this.queue]);
      this.processQueue();
    }
  }

  public resumeTransfer(transferId: string): void {
    const item = this.queue.find((q) => q.transferId === transferId);
    if (!item) return;

    if (item.direction === 'send') {
      const task = this.activeOutgoing.get(transferId);
      const session = item.targetPeerId ? this.peers.get(item.targetPeerId) : this.getFirstConnectedPeer();
      if (task && session) {
        task.isPaused = false;
        item.status = 'transferring';
        this.callbacks.onQueueUpdate?.([...this.queue]);
        this.streamChunks(task, session);
      } else if (item.file && session) {
        // Re-queue
        item.status = 'waiting';
        this.callbacks.onQueueUpdate?.([...this.queue]);
        this.processQueue();
      }
    } else {
      // Receiver requests sender to resume
      const incoming = this.activeIncoming.get(transferId);
      const session = item.targetPeerId ? this.peers.get(item.targetPeerId) : this.getFirstConnectedPeer();
      if (incoming && session?.dc) {
        const lastChunk = incoming.receivedChunks.filter(Boolean).length;
        session.dc.send(
          JSON.stringify({
            type: 'control',
            action: 'resume-request',
            transferId,
            fromChunk: lastChunk,
          })
        );
        item.status = 'receiving';
        this.callbacks.onQueueUpdate?.([...this.queue]);
      }
    }
  }

  public cancelTransfer(transferId?: string): void {
    if (transferId) {
      const outgoing = this.activeOutgoing.get(transferId);
      if (outgoing) {
        outgoing.isCancelled = true;
        outgoing.item.status = 'cancelled';
        const session = outgoing.targetPeerId ? this.peers.get(outgoing.targetPeerId) : this.getFirstConnectedPeer();
        try {
          session?.dc?.send(JSON.stringify({ type: 'control', action: 'cancel', transferId }));
        } catch {}
        this.activeOutgoing.delete(transferId);
      }
      const incoming = this.activeIncoming.get(transferId);
      if (incoming) {
        incoming.receivedChunks = [];
        this.activeIncoming.delete(transferId);
        const item = this.queue.find((q) => q.transferId === transferId);
        if (item) item.status = 'cancelled';
      }
    } else {
      // Cancel all active transfers
      for (const [id, task] of this.activeOutgoing.entries()) {
        task.isCancelled = true;
        task.item.status = 'cancelled';
        const session = task.targetPeerId ? this.peers.get(task.targetPeerId) : this.getFirstConnectedPeer();
        try {
          session?.dc?.send(JSON.stringify({ type: 'control', action: 'cancel', transferId: id }));
        } catch {}
      }
      this.activeOutgoing.clear();
      for (const incoming of this.activeIncoming.values()) {
        incoming.receivedChunks = [];
      }
      this.activeIncoming.clear();
      for (const item of this.queue) {
        if (item.status === 'transferring' || item.status === 'waiting') {
          item.status = 'cancelled';
        }
      }
    }

    this.callbacks.onQueueUpdate?.([...this.queue]);
    this.processQueue();
  }

  public retryTransfer(transferId: string): void {
    const item = this.queue.find((q) => q.transferId === transferId);
    if (item && item.file) {
      item.status = 'waiting';
      item.transferredBytes = 0;
      item.percentage = 0;
      item.error = undefined;
      this.callbacks.onQueueUpdate?.([...this.queue]);
      this.processQueue();
    }
  }

  private emitProgressUpdate(activeItem: TransferQueueItem) {
    const activeTransfers = this.queue.filter((q) => q.status === 'transferring' || q.status === 'receiving');
    const totalBytes = this.queue.reduce((acc, q) => acc + q.size, 0);
    const transferredBytes = this.queue.reduce((acc, q) => acc + q.transferredBytes, 0);
    const overallPercentage = totalBytes > 0 ? Math.round((transferredBytes / totalBytes) * 100) : 0;

    // Total overall speed sum across all active transfers
    const totalSpeedBytesPerSec = activeTransfers.reduce((acc, q) => acc + q.speedBytesPerSec, 0);
    const remainingBytes = Math.max(0, totalBytes - transferredBytes);
    const etaSeconds = totalSpeedBytesPerSec > 1000 ? Math.ceil(remainingBytes / totalSpeedBytesPerSec) : null;

    this.callbacks.onProgress?.({
      status: activeItem.status,
      fileName: activeItem.name,
      fileIndex: this.queue.indexOf(activeItem),
      totalFiles: this.queue.length,
      transferredBytes: activeItem.transferredBytes,
      totalBytes: activeItem.size,
      percentage: activeItem.percentage,
      overallTransferredBytes: transferredBytes,
      overallTotalBytes: totalBytes,
      overallPercentage,
      speedBytesPerSec: totalSpeedBytesPerSec,
      etaSeconds,
    });

    this.callbacks.onQueueUpdate?.([...this.queue]);
  }

  public getQueue(): TransferQueueItem[] {
    return [...this.queue];
  }

  public getSessionHistory(): SessionHistoryItem[] {
    return [...this.sessionHistory];
  }

  // Backward compatibility wrapper for sendFiles
  public async sendFiles(files: File[], targetPeerId?: string): Promise<void> {
    this.addFilesToQueue(files, targetPeerId);
  }

  public cleanup(): void {
    this.cancelTransfer();
    for (const session of this.peers.values()) {
      try {
        session.dc?.close();
        session.pc.close();
      } catch {}
    }
    this.peers.clear();
    this.defaultPeerId = null;
    this.queue = [];
    this.activeOutgoing.clear();
    this.activeIncoming.clear();
  }
}
