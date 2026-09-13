import React, { useState, useEffect, useRef } from 'react';
import type {
  ConnectionState,
  PeerDevice,
  ReceivedFile,
  TransferProgress,
} from './types/index.ts';
import { SignalingClient } from './services/signaling.ts';
import { WebRTCService } from './services/webrtc.ts';
import { getSignalingConfig } from './config.ts';
import { generateQRCodeSVG } from './utils/qr.ts';

type AppStep =
  | 'home'
  | 'creating_room'
  | 'joining_room'
  | 'connected'
  | 'transferring'
  | 'completed'
  | 'error';

function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

function formatEta(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return '--';
  if (seconds < 60) return `${seconds}s remaining`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s < 10 ? '0' : ''}${s}s remaining`;
}

function getDefaultDeviceName(): string {
  if (typeof window === 'undefined') return 'Device';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android Device';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'Apple Device';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows NT/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Browser Device';
}

export default function App() {
  const [step, setStep] = useState<AppStep>('home');
  const [connectionState, setConnectionState] = useState<ConnectionState>('DISCONNECTED');
  const [roomCode, setRoomCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [copySuccess, setCopySuccess] = useState<boolean>(false);

  // Device naming
  const [deviceName, setDeviceName] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('crossdrop_device_name');
      if (saved && saved.trim()) return saved.trim();
    }
    return getDefaultDeviceName();
  });
  const [peerDevice, setPeerDevice] = useState<PeerDevice | null>(null);

  // File state (Multiple files)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [isSender, setIsSender] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCService | null>(null);

  // Update local device name in storage and WebRTC
  const handleDeviceNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setDeviceName(newName);
    if (typeof window !== 'undefined') {
      localStorage.setItem('crossdrop_device_name', newName);
    }
    webrtcRef.current?.setDeviceName(newName);
  };

  // Check URL query parameter on load for instant QR join
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      const joinParam = params.get('join');
      if (joinParam && /^\d{6}$/.test(joinParam.trim())) {
        setInputCode(joinParam.trim());
        setStep('joining_room');
      }
    }
  }, []);

  // Initialize WebRTC and Signaling services
  useEffect(() => {
    const config = getSignalingConfig();
    if (config.isConfigured) {
      console.log(`[CrossDrop] Signaling URL: ${config.url}`);
    }

    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    const webrtc = new WebRTCService((signal) => {
      signaling.sendSignal(signal);
    });
    webrtc.setDeviceName(deviceName);
    webrtcRef.current = webrtc;

    // WebRTC Callbacks
    webrtc.setCallbacks({
      onConnectionStateChange: (state) => {
        setConnectionState(state);
        if (state === 'CONNECTED') {
          setStep((prev) => (prev === 'transferring' || prev === 'completed' ? prev : 'connected'));
        } else if (state === 'DISCONNECTED') {
          setErrorMessage('Peer device disconnected.');
          setStep('error');
        } else if (state === 'ERROR') {
          setStep('error');
        }
      },
      onPeerInfo: (peer) => {
        setPeerDevice(peer);
      },
      onProgress: (p) => {
        setProgress(p);
        if (p.status === 'sending' || p.status === 'receiving') {
          setStep('transferring');
        } else if (p.status === 'completed') {
          setStep('completed');
        } else if (p.status === 'cancelled' || p.status === 'failed') {
          if (p.error) setErrorMessage(p.error);
          setStep('connected');
        }
      },
      onFileReceived: (file) => {
        setReceivedFiles((prev) => [...prev, file]);
        setIsSender(false);
      },
      onError: (err) => {
        setErrorMessage(err);
        setStep('error');
      },
    });

    // Signaling Callbacks
    signaling.setCallbacks({
      onStateChange: (state) => {
        setConnectionState((prev) => {
          // Keep WebRTC state if already connected or transferring
          if (prev === 'CONNECTED' || prev === 'TRANSFERRING' || prev === 'COMPLETED') {
            return prev;
          }
          return state;
        });
      },
      onRoomCreated: (_id, code) => {
        setRoomCode(code);
        setStep('creating_room');
        setConnectionState('WAITING_FOR_PEER');
      },
      onRoomJoined: (_id, _code) => {
        setConnectionState('NEGOTIATING');
        webrtc.initConnection(false); // Joiner waits for offer
      },
      onPeerJoined: () => {
        setConnectionState('NEGOTIATING');
        webrtc.initConnection(true); // Creator initiates offer
      },
      onSignal: (signalData) => {
        webrtc.handleSignal(signalData);
      },
      onPeerDisconnected: (reason) => {
        setErrorMessage(reason || 'Device disconnected.');
        setConnectionState('DISCONNECTED');
        setStep('error');
        webrtc.cleanup();
      },
      onError: (_code, message) => {
        setErrorMessage(message);
        setConnectionState('ERROR');
        setStep('error');
      },
    });

    return () => {
      signaling.disconnect();
      webrtc.cleanup();
    };
  }, []);

  const handleCreateRoom = async () => {
    try {
      setErrorMessage('');
      setConnectionState('CONNECTING');
      if (signalingRef.current) {
        await signalingRef.current.connect();
        signalingRef.current.createRoom();
      }
    } catch {
      setErrorMessage('Could not connect to signaling server.');
      setConnectionState('ERROR');
      setStep('error');
    }
  };

  const handleJoinRoom = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const cleanCode = inputCode.trim();
    if (!/^\d{6}$/.test(cleanCode)) {
      setErrorMessage('Pairing code must be a 6-digit number.');
      setStep('error');
      return;
    }

    try {
      setErrorMessage('');
      setConnectionState('CONNECTING');
      if (signalingRef.current) {
        await signalingRef.current.connect();
        signalingRef.current.joinRoom(cleanCode);
      }
    } catch {
      setErrorMessage('Could not connect to signaling server.');
      setConnectionState('ERROR');
      setStep('error');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const filesArray = Array.from(e.target.files);
      setSelectedFiles(filesArray);
      setErrorMessage('');
    }
  };

  const handleRemoveFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Drag and Drop Event Handlers
  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const filesArray = Array.from(e.dataTransfer.files);
      setSelectedFiles(filesArray);
      setErrorMessage('');
    }
  };

  const handleSendFiles = async () => {
    if (selectedFiles.length === 0 || !webrtcRef.current) return;
    setIsSender(true);
    setErrorMessage('');

    try {
      await webrtcRef.current.sendFiles(selectedFiles);
    } catch (err: any) {
      setErrorMessage(err.message || 'File transfer failed.');
      setStep('connected');
    }
  };

  const handleCancelTransfer = () => {
    if (webrtcRef.current) {
      webrtcRef.current.cancelTransfer();
    }
  };

  const handleDownload = (file: ReceivedFile) => {
    const a = document.createElement('a');
    a.href = file.url;
    a.download = file.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDownloadAll = () => {
    receivedFiles.forEach((file, index) => {
      setTimeout(() => handleDownload(file), index * 300);
    });
  };

  const handleSendMoreFiles = () => {
    setSelectedFiles([]);
    setReceivedFiles([]);
    setProgress(null);
    setErrorMessage('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStep('connected');
  };

  const handleFullReset = () => {
    setSelectedFiles([]);
    setReceivedFiles([]);
    setProgress(null);
    setErrorMessage('');
    setRoomCode('');
    setInputCode('');
    setPeerDevice(null);
    setConnectionState('DISCONNECTED');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (signalingRef.current) {
      signalingRef.current.leaveRoom();
    }
    if (webrtcRef.current) {
      webrtcRef.current.cleanup();
    }
    setStep('home');
  };

  const handleCopyCode = () => {
    if (roomCode && navigator.clipboard) {
      navigator.clipboard.writeText(roomCode);
      setCopySuccess(true);
      setTimeout(() => setCopySuccess(false), 2000);
    }
  };

  // QR Code URL & SVG Generation
  const joinUrl =
    typeof window !== 'undefined' && roomCode
      ? `${window.location.origin}/?join=${roomCode}`
      : '';
  const qrSvg = joinUrl ? generateQRCodeSVG(joinUrl, 180) : '';

  const totalSelectedBytes = selectedFiles.reduce((acc, f) => acc + f.size, 0);

  return (
    <main className="app-container">
      {/* App Header */}
      <header className="app-header">
        <h1 className="app-title">
          CrossDrop <span className="app-badge">Phase 2</span>
        </h1>
        <p className="app-subtitle">Direct, peer-to-peer file transfer between your devices</p>

        {/* Device Name Banner */}
        <div className="device-bar" style={{ marginTop: '0.75rem' }}>
          <div className="device-label">
            <span>💻</span>
            <span>Your Device:</span>
            <input
              type="text"
              className="device-input-inline"
              value={deviceName}
              onChange={handleDeviceNameChange}
              title="Click to change device name"
              maxLength={24}
            />
          </div>
          {peerDevice && (
            <div className="peer-badge" title="Connected Peer">
              <span>📱</span>
              <span>{peerDevice.name}</span>
            </div>
          )}
        </div>
      </header>

      {/* Real Connection State Banner */}
      {connectionState !== 'DISCONNECTED' && (
        <div
          className={`status-banner ${
            connectionState === 'CONNECTED' || connectionState === 'COMPLETED'
              ? 'connected'
              : connectionState === 'ERROR'
              ? 'error'
              : 'connecting'
          }`}
        >
          <span className="status-dot" />
          <span>
            {connectionState === 'CONNECTED'
              ? peerDevice
                ? `✓ Connected to ${peerDevice.name}`
                : '✓ Connected to Peer'
              : connectionState === 'WAKING'
              ? '⏳ Waking server (Render free tier cold start ~30s)...'
              : connectionState === 'WAITING_FOR_PEER'
              ? 'Waiting for another device to connect...'
              : connectionState === 'NEGOTIATING'
              ? 'Establishing direct P2P link...'
              : connectionState === 'RECONNECTING'
              ? '🔄 Reconnecting to signaling server...'
              : connectionState === 'TRANSFERRING'
              ? 'Transferring files...'
              : connectionState === 'COMPLETED'
              ? '✓ Transfer complete'
              : connectionState === 'CONNECTING'
              ? 'Connecting to server...'
              : connectionState}
          </span>
        </div>
      )}

      {/* Screen 1: Home View */}
      {step === 'home' && (
        <section className="card-section">
          <div className="btn-group">
            <button id="create-room-btn" className="btn btn-primary" onClick={handleCreateRoom}>
              Create Room
            </button>
            <button
              id="join-room-btn"
              className="btn btn-secondary"
              onClick={() => {
                setErrorMessage('');
                setStep('joining_room');
              }}
            >
              Join Room
            </button>
          </div>
        </section>
      )}

      {/* Screen 2: Room Created (QR Code & 6-Digit Code) */}
      {step === 'creating_room' && (
        <section className="card-section">
          <div className="code-box">
            <span className="code-title">Scan QR code or enter 6-digit code</span>

            {/* QR Code pairing */}
            {qrSvg && (
              <div className="qr-box">
                <div
                  className="qr-image-wrapper"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
                <span className="qr-hint">Scan with your phone's camera to join instantly</span>
              </div>
            )}

            <span className="code-digits">{roomCode}</span>

            <button
              className="btn btn-secondary"
              onClick={handleCopyCode}
              style={{ width: 'auto', minHeight: '38px', padding: '0.45rem 1rem', fontSize: '0.85rem' }}
            >
              {copySuccess ? '✓ Code Copied!' : '📋 Copy Pairing Code'}
            </button>

            <span className="code-hint">Keep this window open until connected</span>
          </div>

          <button className="btn btn-secondary" onClick={handleFullReset}>
            Cancel
          </button>
        </section>
      )}

      {/* Screen 3: Join Room */}
      {step === 'joining_room' && (
        <section className="card-section">
          <form className="input-group" onSubmit={handleJoinRoom}>
            <label htmlFor="pairing-code" className="input-label">
              Enter the 6-digit pairing code
            </label>
            <input
              id="pairing-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={6}
              className="code-input"
              placeholder="123456"
              autoFocus
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.replace(/\D/g, ''))}
            />
            <div className="btn-group" style={{ marginTop: '0.5rem' }}>
              <button
                type="submit"
                id="submit-join-btn"
                className="btn btn-primary"
                disabled={inputCode.trim().length !== 6}
              >
                Connect to Device
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => {
                  setErrorMessage('');
                  setStep('home');
                }}
              >
                Back
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Screen 4: Connected — Multi-File Selection & Drag/Drop */}
      {step === 'connected' && (
        <section className="card-section">
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileSelect}
            className="sr-only-input"
            id="file-selector-input"
          />

          {/* Interactive Drag & Drop Area */}
          <div
            className={`drop-zone ${isDragging ? 'active' : ''}`}
            onDragEnter={handleDragEnter}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className="drop-zone-icon">📁</span>
            <div className="drop-zone-title">
              {isDragging ? 'Drop files here!' : 'Choose or drop files to send'}
            </div>
            <div className="drop-zone-subtitle">
              Click to browse or drag & drop one or multiple files
            </div>
          </div>

          {/* Selected File(s) Queue */}
          {selectedFiles.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
              <div className="queue-summary">
                <span>Selected Files ({selectedFiles.length}):</span>
                <span>Total: {formatBytes(totalSelectedBytes)}</span>
              </div>
              <div className="file-queue">
                {selectedFiles.map((file, idx) => (
                  <div key={idx} className="file-queue-item">
                    <span className="file-queue-name" title={file.name}>
                      {file.name}
                    </span>
                    <span className="file-queue-size">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      className="btn-remove-file"
                      onClick={() => handleRemoveFile(idx)}
                      title="Remove file"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <button
                id="send-file-btn"
                className="btn btn-primary"
                onClick={handleSendFiles}
                style={{ marginTop: '0.5rem' }}
              >
                Send {selectedFiles.length === 1 ? '1 File' : `${selectedFiles.length} Files`}
              </button>
            </div>
          )}

          <button className="btn btn-danger" onClick={handleFullReset} style={{ marginTop: '0.25rem' }}>
            Disconnect
          </button>
        </section>
      )}

      {/* Screen 5: Transferring Active Progress */}
      {step === 'transferring' && progress && (
        <section className="card-section">
          <div className="progress-card">
            <div className="progress-header">
              <span className="progress-title">
                {progress.status === 'sending' ? 'Sending' : 'Receiving'}{' '}
                {progress.totalFiles > 1 ? `(${progress.fileIndex + 1}/${progress.totalFiles}): ` : ': '}
                {progress.fileName}
              </span>
              <span className="progress-percent">
                {progress.totalFiles > 1 ? `${progress.overallPercentage}%` : `${progress.percentage}%`}
              </span>
            </div>

            <div className="progress-bar-bg">
              <div
                className="progress-bar-fill"
                style={{
                  width: `${progress.totalFiles > 1 ? progress.overallPercentage : progress.percentage}%`,
                }}
              />
            </div>

            <div className="progress-footer">
              <span>
                {formatBytes(progress.totalFiles > 1 ? progress.overallTransferredBytes : progress.transferredBytes)} /{' '}
                {formatBytes(progress.totalFiles > 1 ? progress.overallTotalBytes : progress.totalBytes)}
              </span>
              <span>{progress.percentage}% file</span>
            </div>

            {/* Live Metrics Row: Speed & ETA */}
            <div className="metrics-row">
              <span className="metric-badge">
                <span>⚡</span>
                <span className="metric-value">
                  {progress.speedBytesPerSec > 0 ? `${formatBytes(progress.speedBytesPerSec)}/s` : 'Calculating...'}
                </span>
              </span>
              <span className="metric-badge">
                <span>⏱️</span>
                <span className="metric-value">{formatEta(progress.etaSeconds)}</span>
              </span>
            </div>
          </div>

          <button className="btn btn-danger" onClick={handleCancelTransfer}>
            Cancel Transfer
          </button>
        </section>
      )}

      {/* Screen 6: Transfer Completed / Received Files */}
      {step === 'completed' && (
        <section className="card-section">
          <div className="success-box">
            <span className="success-icon">✓</span>
            <div className="success-title">Transfer Complete!</div>

            {/* Sender summary */}
            {isSender && (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
                All {selectedFiles.length} file(s) ({formatBytes(totalSelectedBytes)}) were delivered directly to{' '}
                {peerDevice?.name || 'peer'}.
              </p>
            )}

            {/* Receiver multi-file download list */}
            {!isSender && receivedFiles.length > 0 && (
              <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', fontWeight: 600 }}>
                    Received Files ({receivedFiles.length}):
                  </span>
                  {receivedFiles.length > 1 && (
                    <button
                      className="btn btn-success"
                      style={{ width: 'auto', minHeight: '36px', padding: '0.35rem 0.8rem', fontSize: '0.8rem' }}
                      onClick={handleDownloadAll}
                    >
                      Download All
                    </button>
                  )}
                </div>

                <div className="received-list">
                  {receivedFiles.map((file, idx) => (
                    <div key={file.id || idx} className="received-item">
                      <div className="received-item-info">
                        <span className="received-item-name">{file.name}</span>
                        <span className="received-item-size">{formatBytes(file.size)}</span>
                      </div>
                      <button
                        className="btn-download-sm"
                        onClick={() => handleDownload(file)}
                      >
                        Download
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="btn-group">
            <button className="btn btn-primary" onClick={handleSendMoreFiles}>
              Send More Files
            </button>
            <button className="btn btn-secondary" onClick={handleFullReset}>
              Leave Room
            </button>
          </div>
        </section>
      )}

      {/* Error Message Display */}
      {errorMessage && (
        <div className="status-banner error" style={{ wordBreak: 'break-word' }}>
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Error Screen Actions */}
      {step === 'error' && (
        <section className="card-section">
          <button className="btn btn-secondary" onClick={handleFullReset}>
            Start Over
          </button>
        </section>
      )}
    </main>
  );
}
