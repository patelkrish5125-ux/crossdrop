/**
 * CrossDrop Transport Layer Abstraction Types
 * Prepares CrossDrop for hybrid Wi-Fi + Bluetooth native transports in the future
 * while preserving high-speed WebRTC RTCDataChannel as the primary web transport.
 */

import type { ConnectionState } from '../../types/index.ts';

export type TransportType = 'webrtc' | 'bluetooth-ble' | 'wifi-direct' | 'mock';

export interface TransportCapability {
  id: string;
  name: string;
  type: TransportType;
  isSupportedInBrowser: boolean;
  isAvailable: boolean;
  requiresSecureContext: boolean;
  statusText: string;
  diagnosticNotes: string[];
}

export interface ITransport {
  id: string;
  name: string;
  type: TransportType;
  state: ConnectionState;
  isReady: boolean;
  getCapability(): TransportCapability;
  getDiagnostics(): Record<string, any>;
  disconnect(): void;
}
