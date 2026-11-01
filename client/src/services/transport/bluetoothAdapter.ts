/**
 * CrossDrop Bluetooth LE Capability Adapter
 *
 * Technical Reality of Web Bluetooth in Browsers:
 * 1. The standard W3C Web Bluetooth API (navigator.bluetooth) only implements the GATT Central role (client).
 *    It can discover and connect to external peripheral devices (like heart rate sensors or fitness trackers).
 * 2. Crucially, the W3C Web Bluetooth specification in web browsers DOES NOT support the GATT Peripheral / Server
 *    role. A web browser cannot advertise BLE services or accept incoming BLE connections from another browser.
 * 3. Major browsers like Apple Safari (iOS/macOS) and Mozilla Firefox have explicitly disabled Web Bluetooth.
 * 4. Therefore, browser-to-browser file transfer over Web Bluetooth is physically impossible without a native
 *    app bridge or native OS capabilities (such as Android Nearby Share, Wi-Fi Direct, or native BLE daemon).
 *
 * This adapter provides honest, zero-compromise capability diagnostics:
 * - Detects browser support without opening unsolicited permission prompts.
 * - Explains actual capabilities and limitations.
 * - Never fakes Bluetooth connections or routes actual file bytes through Bluetooth.
 * - Prepares the architecture for future native app wrapper integration.
 */

import type { ITransport, TransportCapability, TransportType } from './types.ts';
import type { ConnectionState } from '../../types/index.ts';

export class BluetoothAdapter implements ITransport {
  public readonly id = 'transport-bluetooth-ble';
  public readonly name = 'Bluetooth LE Discovery Adapter';
  public readonly type: TransportType = 'bluetooth-ble';
  public state: ConnectionState = 'DISCONNECTED';

  private cachedCapability: TransportCapability | null = null;

  public get isReady(): boolean {
    return false; // In browser web apps, Bluetooth is NOT ready for browser-to-browser file transfer
  }

  /**
   * Safe capability inspection without prompting the user for permissions.
   */
  public getCapability(): TransportCapability {
    if (this.cachedCapability) return this.cachedCapability;

    const hasNavigator = typeof navigator !== 'undefined';
    const isSecure = typeof window !== 'undefined' ? window.isSecureContext : false;
    const hasBluetoothApi = hasNavigator && 'bluetooth' in navigator && Boolean((navigator as any).bluetooth);

    const diagnosticNotes: string[] = [];

    if (!isSecure) {
      diagnosticNotes.push('Insecure context: Web Bluetooth strictly requires HTTPS or localhost.');
    }

    if (!hasBluetoothApi) {
      diagnosticNotes.push('Web Bluetooth API is not implemented in this browser engine (e.g. Safari, Firefox).');
    } else {
      diagnosticNotes.push('Web Bluetooth API detected (GATT Central/Client mode only).');
      diagnosticNotes.push('Browser engine lacks GATT Peripheral/Server mode required for browser-to-browser BLE discovery.');
    }

    diagnosticNotes.push('High-speed Wi-Fi / WebRTC is the active primary transport.');

    // Status explanation following Part 7 requirements:
    // If the browser cannot support the required Bluetooth functionality, clearly report:
    // "Bluetooth-assisted device discovery is not available in this browser version."
    const statusText = hasBluetoothApi && isSecure
      ? 'Web Bluetooth API present (GATT Central only; GATT Peripheral unavailable for browser-to-browser discovery).'
      : 'Bluetooth-assisted device discovery is not available in this browser version.';

    this.cachedCapability = {
      id: this.id,
      name: this.name,
      type: this.type,
      isSupportedInBrowser: hasBluetoothApi && isSecure,
      isAvailable: false, // Cannot be used for browser-to-browser P2P
      requiresSecureContext: true,
      statusText,
      diagnosticNotes,
    };

    return this.cachedCapability;
  }

  /**
   * User-triggered interactive capability test.
   * Only called when the user explicitly clicks "Test Bluetooth Availability" in diagnostics.
   * Never invoked automatically on load or room creation.
   */
  public async testUserRequestedAvailability(): Promise<{
    available: boolean;
    reason: string;
  }> {
    if (typeof navigator === 'undefined' || !('bluetooth' in navigator)) {
      return {
        available: false,
        reason: 'Bluetooth-assisted device discovery is not available in this browser version.',
      };
    }

    if (!window.isSecureContext) {
      return {
        available: false,
        reason: 'Web Bluetooth requires an HTTPS secure origin.',
      };
    }

    try {
      const bluetooth = (navigator as any).bluetooth;
      if (typeof bluetooth.getAvailability === 'function') {
        const isRadioOn = await bluetooth.getAvailability();
        if (!isRadioOn) {
          return {
            available: false,
            reason: 'Bluetooth radio is powered off or disabled on this device.',
          };
        }
      }

      return {
        available: false,
        reason:
          'Browser supports Web Bluetooth (GATT Client), but browser-to-browser discovery requires native peripheral mode. CrossDrop uses direct Wi-Fi P2P instead.',
      };
    } catch (err: any) {
      return {
        available: false,
        reason: err.message || 'Bluetooth capability check failed.',
      };
    }
  }

  public getDiagnostics(): Record<string, any> {
    const cap = this.getCapability();
    return {
      adapter: this.name,
      supported: cap.isSupportedInBrowser,
      status: cap.statusText,
      notes: cap.diagnosticNotes,
      futureArchitecture: 'Ready for native BLE peripheral bridge via Android/iOS/Desktop native wrappers.',
    };
  }

  public disconnect(): void {
    this.state = 'DISCONNECTED';
  }
}

export const bluetoothAdapter = new BluetoothAdapter();
