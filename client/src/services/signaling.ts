import { getSignalingConfig, getHealthCheckUrl } from '../config.ts';
import type { ConnectionState, SignalingClientMessage, SignalingServerMessage } from '../types/index.ts';

export interface SignalingCallbacks {
  onRoomCreated?: (roomId: string, code: string) => void;
  onRoomJoined?: (roomId: string, code: string) => void;
  onPeerJoined?: () => void;
  onSignal?: (signalData: any) => void;
  onPeerDisconnected?: (reason?: string) => void;
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

  // Reconnection state
  private currentRoomCode: string | null = null;
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
  private async waitForServerWakeup(maxWaitMs = 60000): Promise<boolean> {
    const healthUrl = getHealthCheckUrl();
    const startTime = Date.now();
    this.isWaking = true;
    this.abortWaking = false;
    this.notifyState('WAKING', 'Waking up server (Render free tier cold start ~30s)...');
    console.log(`[CrossDrop Signaling] Probing health endpoint at ${healthUrl} for server wake-up...`);

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
      const errMsg =
        'Signaling server URL is not configured. If running on Netlify, please set VITE_SIGNALING_URL in your Netlify site settings (e.g. wss://<your-service>.onrender.com).';
      console.error('[CrossDrop Signaling] Connection blocked: ' + errMsg);
      this.callbacks.onError?.('SERVER_CONNECTION_ERROR', 'Could not connect to signaling server.');
      return Promise.reject(new Error(errMsg));
    }

    this.isIntentionalDisconnect = false;

    // Attempt direct WebSocket connection first
    try {
      await this.rawConnect();
    } catch {
      // If direct connection fails, the Render container may be cold-sleeping.
      // Probe /health endpoint and retry once the server wakes up.
      console.warn('[CrossDrop Signaling] Initial connection failed. Checking if server is waking up...');
      const isAwake = await this.waitForServerWakeup(60000);
      if (isAwake && !this.abortWaking) {
        this.notifyState('CONNECTING', 'Server ready. Connecting signaling channel...');
        await this.rawConnect();
      } else {
        this.notifyState('DISCONNECTED', 'Signaling server unreachable');
        this.callbacks.onError?.('SERVER_CONNECTION_ERROR', 'Could not connect to signaling server.');
        throw new Error('Signaling server is unreachable or failed to wake up in time.');
      }
    }
  }

  private rawConnect(): Promise<void> {
    this.isConnecting = true;
    this.notifyState('CONNECTING', 'Connecting to signaling server...');

    return new Promise((resolve, reject) => {
      let isSettled = false;
      console.log(`[CrossDrop Signaling] Connecting to: ${this.url}`);

      try {
        const socket = new WebSocket(this.url);
        this.ws = socket;

        socket.onopen = () => {
          this.isConnecting = false;
          this.reconnectAttempts = 0;
          if (!isSettled) {
            isSettled = true;
            console.log('[CrossDrop Signaling] Connected to signaling server.');
            this.notifyState('SIGNALING_CONNECTED', 'Connected to signaling server');
            resolve();
          }
        };

        socket.onclose = (event) => {
          this.isConnecting = false;
          const wasClean = event.wasClean;
          const code = event.code;
          const reason = event.reason || '(no reason provided by server)';
          console.warn(
            `[CrossDrop Signaling] Disconnected from ${this.url} (code: ${code}, reason: "${reason}", wasClean: ${wasClean})`
          );

          this.ws = null;

          if (!isSettled) {
            isSettled = true;
            reject(new Error(`Could not connect to signaling server (code ${code})`));
          }

          // Trigger automatic reconnection if disconnection was unexpected during an active session
          if (!this.isIntentionalDisconnect && this.currentRoomCode) {
            this.scheduleReconnect();
          } else {
            this.notifyState('DISCONNECTED', 'Disconnected');
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
          this.joinRoom(this.currentRoomCode);
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
        this.notifyState('WAITING_FOR_PEER', 'Room created, waiting for peer');
        this.callbacks.onRoomCreated?.(msg.roomId, msg.code);
        break;
      case 'room-joined':
        this.currentRoomCode = msg.code;
        this.notifyState('NEGOTIATING', 'Joined room, negotiating connection');
        this.callbacks.onRoomJoined?.(msg.roomId, msg.code);
        break;
      case 'peer-joined':
        this.notifyState('NEGOTIATING', 'Peer joined, establishing P2P connection');
        this.callbacks.onPeerJoined?.();
        break;
      case 'signal':
        this.callbacks.onSignal?.(msg.signalData);
        break;
      case 'peer-disconnected':
        this.callbacks.onPeerDisconnected?.(msg.reason);
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

  public createRoom() {
    this.send({ type: 'create-room' });
  }

  public joinRoom(code: string) {
    this.currentRoomCode = code;
    this.send({ type: 'join-room', code });
  }

  public sendSignal(signalData: any) {
    this.send({ type: 'signal', signalData });
  }

  public leaveRoom() {
    this.currentRoomCode = null;
    this.isIntentionalDisconnect = true;
    clearTimeout(this.reconnectTimer);
    this.send({ type: 'leave-room' });
    this.notifyState('DISCONNECTED', 'Left room');
  }

  public disconnect() {
    this.isIntentionalDisconnect = true;
    this.currentRoomCode = null;
    this.abortWaking = true;
    clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.notifyState('DISCONNECTED', 'Disconnected');
  }
}
