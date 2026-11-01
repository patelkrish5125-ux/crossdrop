import React, { useState } from 'react';
import type { NetworkDiagnosticsData } from '../types/index.ts';
import { transportManager } from '../services/transport/transportManager.ts';

interface NetworkDiagnosticsProps {
  data: NetworkDiagnosticsData;
  isOpen: boolean;
  onClose: () => void;
}

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export const NetworkDiagnostics: React.FC<NetworkDiagnosticsProps> = ({ data, isOpen, onClose }) => {
  const [btTestResult, setBtTestResult] = useState<string | null>(null);
  const [isTestingBt, setIsTestingBt] = useState(false);

  if (!isOpen) return null;

  const handleTestBluetooth = async () => {
    setIsTestingBt(true);
    try {
      const result = await transportManager.testBluetoothAvailability();
      setBtTestResult(result.reason);
    } catch (err: any) {
      setBtTestResult(err.message || 'Bluetooth test failed.');
    } finally {
      setIsTestingBt(false);
    }
  };

  return (
    <div className="diag-overlay" onClick={onClose}>
      <div className="diag-modal" onClick={(e) => e.stopPropagation()}>
        <div className="diag-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ fontSize: '1.25rem' }}>📶</span>
            <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Network & Transport Diagnostics</h3>
          </div>
          <button className="diag-close-btn" onClick={onClose} title="Close diagnostics">
            ✕
          </button>
        </div>

        <div className="diag-body">
          {/* Section 1: Connection & Signaling */}
          <div className="diag-section">
            <h4 className="diag-section-title">Signaling & Session State</h4>
            <div className="diag-grid">
              <div className="diag-item">
                <span className="diag-label">Signaling State</span>
                <span className={`diag-value badge-${data.signalingState.toLowerCase()}`}>
                  {data.signalingState}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Signaling Endpoint</span>
                <span className="diag-value" title={data.signalingUrl}>
                  {data.signalingUrl.replace(/wss?:\/\//, '')}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Signaling Latency</span>
                <span className="diag-value">
                  {data.signalingLatencyMs !== null ? `${data.signalingLatencyMs} ms` : '--'}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Reconnect Attempts</span>
                <span className="diag-value">{data.reconnectAttempts}</span>
              </div>
            </div>
          </div>

          {/* Section 2: WebRTC P2P Transport & Candidates */}
          <div className="diag-section">
            <h4 className="diag-section-title">WebRTC Transport & Path Analysis</h4>
            <div className="diag-grid">
              <div className="diag-item">
                <span className="diag-label">Peer Connection</span>
                <span className="diag-value">{data.peerConnectionState}</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">ICE Connection</span>
                <span className="diag-value">{data.iceConnectionState}</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">DataChannel State</span>
                <span className="diag-value">{data.dataChannelState}</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Round Trip Time (RTT)</span>
                <span className="diag-value">{data.roundTripTimeMs !== null ? `${data.roundTripTimeMs} ms` : '--'}</span>
              </div>
            </div>

            <div className="diag-callout" style={{ marginTop: '0.75rem' }}>
              <div className="diag-callout-header">
                <span style={{ fontWeight: 600 }}>Active Transport Path:</span>
                <span
                  style={{
                    padding: '0.2rem 0.6rem',
                    borderRadius: '4px',
                    fontSize: '0.8rem',
                    fontWeight: 600,
                    background: data.isDirectLan ? 'rgba(16, 185, 129, 0.2)' : 'rgba(59, 130, 246, 0.2)',
                    color: data.isDirectLan ? '#34d399' : '#60a5fa',
                  }}
                >
                  {data.selectedCandidatePath}
                </span>
              </div>
              <p style={{ margin: '0.4rem 0 0 0', fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                {data.isDirectLan
                  ? '✓ Devices are communicating directly over the local Wi-Fi network with zero intermediary relay.'
                  : data.selectedCandidatePath.includes('STUN')
                  ? '✓ Direct peer-to-peer connection established via STUN NAT traversal.'
                  : 'Traffic is routed through TURN relay server.'}
              </p>
            </div>
          </div>

          {/* Section 3: Transfer Performance */}
          <div className="diag-section">
            <h4 className="diag-section-title">Transfer Throughput & Memory</h4>
            <div className="diag-grid">
              <div className="diag-item">
                <span className="diag-label">Measured Speed</span>
                <span className="diag-value" style={{ color: '#60a5fa', fontWeight: 600 }}>
                  {data.speedBytesPerSec > 0 ? (data.speedBytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s' : '--'}
                </span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Session Bytes</span>
                <span className="diag-value">{formatBytes(data.totalTransferredBytes)}</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">DataChannel Buffer</span>
                <span className="diag-value">{formatBytes(data.bufferedAmountBytes)}</span>
              </div>
              <div className="diag-item">
                <span className="diag-label">Last Error</span>
                <span className="diag-value" style={{ color: data.lastError ? '#f87171' : 'var(--text-muted)' }}>
                  {data.lastError || 'None'}
                </span>
              </div>
            </div>
          </div>

          {/* Section 4: Bluetooth & Future Multi-Transport Architecture */}
          <div className="diag-section">
            <h4 className="diag-section-title">Bluetooth & Multi-Transport Architecture</h4>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <span>Web Bluetooth API Support:</span>
                <span style={{ fontWeight: 600, color: data.bluetoothSupported ? '#34d399' : '#f59e0b' }}>
                  {data.bluetoothSupported ? 'Exposed in Browser' : 'Not Supported in Browser'}
                </span>
              </div>

              <div
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  padding: '0.75rem',
                  borderRadius: '6px',
                  marginBottom: '0.75rem',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                }}
              >
                <div style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: '0.25rem' }}>
                  Browser Architecture Finding:
                </div>
                <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  {data.bluetoothStatus}
                </p>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginTop: '0.5rem' }}>
                <button
                  className="btn btn-secondary"
                  style={{ width: 'auto', minHeight: '34px', fontSize: '0.8rem', padding: '0.35rem 0.8rem' }}
                  onClick={handleTestBluetooth}
                  disabled={isTestingBt}
                >
                  {isTestingBt ? 'Testing...' : 'Test Bluetooth Availability'}
                </button>
                {btTestResult && (
                  <span style={{ fontSize: '0.78rem', color: '#c084fc', fontStyle: 'italic' }}>
                    {btTestResult}
                  </span>
                )}
              </div>

              <p style={{ margin: '0.75rem 0 0 0', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                ℹ️ <strong>Future Native Hybrid Transport:</strong> CrossDrop is architected so future native app wrappers (Android Nearby / iOS CoreBluetooth) can use Bluetooth LE for seamless nearby discovery/pairing while WebRTC RTCDataChannel delivers high-speed file payloads over Wi-Fi.
              </p>
            </div>
          </div>
        </div>

        <div className="diag-footer">
          <button className="btn btn-secondary" onClick={onClose} style={{ width: '100%' }}>
            Close Diagnostics
          </button>
        </div>
      </div>
    </div>
  );
};
