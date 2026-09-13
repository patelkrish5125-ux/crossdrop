import { getSignalingConfig, getHealthCheckUrl } from '../config.ts';
import type { ConnectionState, SignalingClientMessage, SignalingServerMessage } from '../types/index.ts';

export interface SignalingCallbacks {
  onRoomCreated?: (roomId: string, code: string, myPeerId?: string) => void;
  onRoomJoined?: (
    roomId: string,
    code: string,
    myPeerId?: string,
    existingPeers?: Array<{ id: string; name: string; role: 'creator' | 'joiner' }>
  ) => void;
  onPeerJoined?: (peer?: { id: string; name: string; role: 'creator' | 'joiner' }) => void;
  onPeerLeft?: (peerId: string, reason?: string) => void;
  onSignal?: (signalData: any, senderPeerId?: string) => void;
  onPeerDisconnected?: (reason?: string, peerId?: string) => void;
  onError?: (code: string, message: string) => void;
  onConnectionChange?: (connected: boolean, statusText?: string) => void;
  onStateChange?: (state: ConnectionState, statusText?: string) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private callbacks: SignalingCallbacks = {};
  private url: string;
  private isConnecting = false;
  private isWaking = false;
  private abortWaking = false;
  private myPeerId: string | null = null;

  // Reconnection state
  private currentRoomCode: string | null = null;
  private currentDeviceName: string | null = null;
  private isIntentionalDisconnect = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectTimer: any = null;

  constructor(serverUrl?: string) {
    if (serverUrl) {
      this.url = serverUrl;
    } else {
      const config = getSignalingConfig();
      this.url = config.url;
    }
  }

  public setCallbacks(callbacks: SignalingCallbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public getTargetUrl(): string {
    return this.url;
  }

  public get isServerWaking(): boolean {
    return this.isWaking;
  }

  public get activeRoomCode(): string | null {
    return this.currentRoomCode;
  }

  public get localPeerId(): string | null {
    return this.myPeerId;
  }

  private notifyState(state: ConnectionState, text?: string) {
    this.callbacks.onStateChange?.(state, text);
    if (state === 'SIGNALING_CONNECTED' || state === 'CONNECTED') {
      this.callbacks.onConnectionChange?.(true, text || 'Connected');
    } else if (state === 'DISCONNECTED' || state === 'ERROR') {
      this.callbacks.onConnectionChange?.(false, text || 'Disconnected');
    }
  }

  /**
   * Probes the server /health endpoint to wait for Render free tier cold-start spinup (~30s).
   */
  public async waitForServerWakeup(maxWaitMs = 60000): Promise<boolean> {
    const healthUrl = getHealthCheckUrl();
    const startTime = Date.now();
    this.isWaking = true;
    this.abortWaking = false;
    this.notifyState('WAKING', 'Waking server (Render free tier cold start ~30s)...');

    console.log(`[CrossDrop Signaling] Probing health at ${healthUrl} for up to ${maxWaitMs / 1000}s...`);

    while (Date.now() - startTime < maxWaitMs && !this.abortWaking) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const res = await fetch(healthUrl, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          console.log('[CrossDrop Signaling] Server is awake and responding to health checks!');
          this.isWaking = false;
          return true;
        }
      } catch {
        // Expected while server container is spinning up
      }

      // Wait 3 seconds before next health probe
      await new Promise((r) => setTimeout(r, 3000));
    }

    this.isWaking = false;
    return false;
  }

  public async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }

    if (this.isConnecting && this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      return new Promise((resolve, reject) => {
        const check = setInterval(() => {
          if (this.ws?.readyState === WebSocket.OPEN) {
            clearInterval(check);
            resolve();
          } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
            clearInterval(check);
            reject(new Error('WebSocket connection failed'));
          }
        }, 50);
      });
    }

    if (!this.url) {
      const errMsg = 'Signaling server URL is not configured.';
      console.error('[CrossDrop Signaling] Connection blocked: ' + errMsg);
      this.callbacks.onError?.('SERVER_CONNECTION_ERROR', 'Could not connect to signaling server.');
      return Promise.reject(new Error(errMsg));
    }

    this.isIntentionalDisconnect = false;

    try {
      await this.rawConnect();
    } catch {
      console.warn('[CrossDrop Signaling] Initial connection failed. Checking if server is waking up...');
      const isAwake = await this.waitForServerWakeup(60000);
      if (isAwake && !this.abortWaking) {
        console.log('[CrossDrop Signaling] Retrying connection after server wake-up...');
        await this.rawConnect();
      } else {
        throw new Error('Signaling server unavailable.');
      }
    }
  }

  private rawConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.isConnecting = true;
      this.notifyState('CONNECTING', 'Connecting to signaling server...');

      try {
        const socket = new WebSocket(this.url);
        this.ws = socket;
        let isSettled = false;

        socket.onopen = () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          this.notifyState('SIGNALING_CONNECTED', 'Connected to signaling server');
          console.log(`[CrossDrop Signaling] WebSocket connected to ${this.url}`);
          if (!isSettled) {
            isSettled = true;
            resolve();
          }
        };

        socket.onclose = (event) => {
          this.isConnecting = false;
          this.ws = null;
          console.log(`[CrossDrop Signaling] WebSocket closed (code: ${event.code}, reason: ${event.reason || 'none'})`);

          if (!isSettled) {
            isSettled = true;
            reject(new Error(`WebSocket failed with code ${event.code}`));
          }

          if (!this.isIntentionalDisconnect && this.currentRoomCode) {
            this.scheduleReconnect();
          } else {
            this.notifyState('DISCONNECTED', 'Disconnected from signaling server');
          }
        };

        socket.onerror = (event) => {
          this.isConnecting = false;
          console.error('[CrossDrop Signaling] WebSocket connection error target:', this.url, event);
          if (!isSettled) {
            isSettled = true;
            reject(new Error('Could not connect to signaling server.'));
          }
        };

        socket.onmessage = (event) => {
          try {
            const msg: SignalingServerMessage = JSON.parse(event.data);
            this.handleMessage(msg);
          } catch (e) {
            console.error('[CrossDrop Signaling] Failed to parse signaling message:', e);
          }
        };
      } catch (err) {
        this.isConnecting = false;
        console.error('[CrossDrop Signaling] Exception during WebSocket initialization:', err);
        reject(err);
      }
    });
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.warn('[CrossDrop Signaling] Max reconnect attempts reached.');
      this.currentRoomCode = null;
      this.notifyState('ERROR', 'Connection lost. Please rejoin or create a new room.');
      this.callbacks.onError?.(
        'RECONNECT_FAILED',
        'Could not restore signaling connection. The room may have expired.'
      );
      return;
    }

    const backoffMs = Math.min(8000, 1000 * Math.pow(2, this.reconnectAttempts));
    this.reconnectAttempts++;
    console.log(
      `[CrossDrop Signaling] Reconnecting in ${backoffMs / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
    );
    this.notifyState('RECONNECTING', `Reconnecting to server (attempt ${this.reconnectAttempts})...`);

    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(async () => {
      try {
        await this.rawConnect();
        if (this.currentRoomCode) {
          console.log(`[CrossDrop Signaling] Re-joining room ${this.currentRoomCode} after reconnect...`);
          this.joinRoom(this.currentRoomCode, this.currentDeviceName || undefined);
        }
      } catch {
        this.scheduleReconnect();
      }
    }, backoffMs);
  }

  private handleMessage(msg: SignalingServerMessage) {
    switch (msg.type) {
      case 'room-created':
        this.currentRoomCode = msg.code;
        this.myPeerId = msg.peerId || null;
        this.notifyState('WAITING_FOR_PEER', 'Room created, waiting for peer');
        this.callbacks.onRoomCreated?.(msg.roomId, msg.code, msg.peerId);
        break;

      case 'room-joined':
        this.currentRoomCode = msg.code;
        this.myPeerId = msg.peerId || null;
        this.notifyState('NEGOTIATING', 'Joined room, negotiating connection');
        this.callbacks.onRoomJoined?.(msg.roomId, msg.code, msg.peerId, msg.peers);
        break;

      case 'peer-joined':
        this.notifyState('NEGOTIATING', 'Peer joined room');
        this.callbacks.onPeerJoined?.(msg.peer);
        break;

      case 'signal':
        this.callbacks.onSignal?.(msg.signalData, msg.senderPeerId);
        break;

      case 'peer-left':
        this.callbacks.onPeerLeft?.(msg.peerId, msg.reason);
        this.callbacks.onPeerDisconnected?.(msg.reason, msg.peerId);
        break;

      case 'peer-disconnected':
        this.callbacks.onPeerDisconnected?.(msg.reason, msg.peerId);
        break;

      case 'error':
        if (msg.code === 'ROOM_NOT_FOUND') {
          this.currentRoomCode = null;
        }
        this.callbacks.onError?.(msg.code, msg.message);
        break;
    }
  }

  public send(msg: SignalingClientMessage) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      console.warn('[CrossDrop Signaling] Cannot send message: WebSocket is not open', msg);
    }
  }

  public createRoom(deviceName?: string) {
    this.currentDeviceName = deviceName || null;
    this.send({ type: 'create-room', deviceName });
  }

  public joinRoom(code: string, deviceName?: string) {
    this.currentRoomCode = code;
    this.currentDeviceName = deviceName || null;
    this.send({ type: 'join-room', code, deviceName });
  }

  public sendSignal(signalData: any, targetPeerId?: string) {
    this.send({ type: 'signal', targetPeerId, signalData });
  }

  public leaveRoom() {
    this.currentRoomCode = null;
    this.myPeerId = null;
    this.isIntentionalDisconnect = true;
    clearTimeout(this.reconnectTimer);
    this.send({ type: 'leave-room' });
    this.notifyState('DISCONNECTED', 'Left room');
  }

  public disconnect() {
    this.isIntentionalDisconnect = true;
    this.currentRoomCode = null;
    this.myPeerId = null;
    this.abortWaking = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.notifyState('DISCONNECTED', 'Disconnected');
  }
}
