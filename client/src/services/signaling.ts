import { getSignalingConfig } from '../config.ts';
import type { SignalingClientMessage, SignalingServerMessage } from '../types/index.ts';

export interface SignalingCallbacks {
  onRoomCreated?: (roomId: string, code: string) => void;
  onRoomJoined?: (roomId: string, code: string) => void;
  onPeerJoined?: () => void;
  onSignal?: (signalData: any) => void;
  onPeerDisconnected?: (reason?: string) => void;
  onError?: (code: string, message: string) => void;
  onConnectionChange?: (connected: boolean, statusText?: string) => void;
}

export class SignalingClient {
  private ws: WebSocket | null = null;
  private callbacks: SignalingCallbacks = {};
  private url: string;
  private isConnecting = false;

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

  public connect(): Promise<void> {
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

    this.isConnecting = true;

    return new Promise((resolve, reject) => {
      let isSettled = false;
      console.log(`[CrossDrop Signaling] Connecting to: ${this.url}`);

      try {
        const socket = new WebSocket(this.url);
        this.ws = socket;

        socket.onopen = () => {
          this.isConnecting = false;
          if (!isSettled) {
            isSettled = true;
            console.log('[CrossDrop Signaling] Connected to signaling server.');
            this.callbacks.onConnectionChange?.(true, 'Connected to signaling server');
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

          this.callbacks.onConnectionChange?.(false, 'Disconnected');
          this.ws = null;

          if (!isSettled) {
            isSettled = true;
            this.callbacks.onError?.('SERVER_CONNECTION_ERROR', 'Could not connect to signaling server.');
            reject(new Error(`Could not connect to signaling server (code ${code})`));
          }
        };

        socket.onerror = (event) => {
          this.isConnecting = false;
          console.error('[CrossDrop Signaling] WebSocket connection error target:', this.url, event);
          if (!isSettled) {
            isSettled = true;
            this.callbacks.onError?.('SERVER_CONNECTION_ERROR', 'Could not connect to signaling server.');
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
        this.callbacks.onError?.('SERVER_CONNECTION_ERROR', 'Could not connect to signaling server.');
        reject(err);
      }
    });
  }

  private handleMessage(msg: SignalingServerMessage) {
    switch (msg.type) {
      case 'room-created':
        this.callbacks.onRoomCreated?.(msg.roomId, msg.code);
        break;
      case 'room-joined':
        this.callbacks.onRoomJoined?.(msg.roomId, msg.code);
        break;
      case 'peer-joined':
        this.callbacks.onPeerJoined?.();
        break;
      case 'signal':
        this.callbacks.onSignal?.(msg.signalData);
        break;
      case 'peer-disconnected':
        this.callbacks.onPeerDisconnected?.(msg.reason);
        break;
      case 'error':
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
    this.send({ type: 'join-room', code });
  }

  public sendSignal(signalData: any) {
    this.send({ type: 'signal', signalData });
  }

  public leaveRoom() {
    this.send({ type: 'leave-room' });
  }

  public disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
