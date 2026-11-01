/**
 * CrossDrop Transport Manager
 *
 * Architecture:
 * TransportManager
 *     |
 *     |-- WebRTC Wi-Fi / network transport (Primary active transport)
 *     |
 *     |-- Bluetooth LE capability adapter (Capability detection & future native pairing)
 *     |
 *     |-- Future native Wi-Fi Direct adapter (Placeholder for Android/iOS native runtime)
 *     |
 *     |-- Future native Bluetooth adapter (Placeholder for native BLE peripheral daemon)
 */

import type { ITransport, TransportCapability } from './types.ts';
import { bluetoothAdapter } from './bluetoothAdapter.ts';

export class TransportManager {
  private transports = new Map<string, ITransport>();

  constructor() {
    this.registerTransport(bluetoothAdapter);
  }

  public registerTransport(transport: ITransport) {
    this.transports.set(transport.id, transport);
  }

  public getTransport(id: string): ITransport | undefined {
    return this.transports.get(id);
  }

  public getAllCapabilities(): TransportCapability[] {
    return Array.from(this.transports.values()).map((t) => t.getCapability());
  }

  public getBluetoothCapability(): TransportCapability {
    return bluetoothAdapter.getCapability();
  }

  public testBluetoothAvailability() {
    return bluetoothAdapter.testUserRequestedAvailability();
  }
}

export const transportManager = new TransportManager();
