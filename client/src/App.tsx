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

/**
 * Parses a 6-digit room code from the current URL if present.
 * Supports /join?room=123456, /?room=123456, /join?join=123456, and /join/123456.
 */
function parseJoinRoomFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const url = new URL(window.location.href);
    const roomParam = url.searchParams.get('room') || url.searchParams.get('join');
    if (roomParam && /^\d{6}$/.test(roomParam.trim())) {
      return roomParam.trim();
    }
    const pathMatch = url.pathname.match(/^\/join\/(\d{6})$/);
    if (pathMatch) {
      return pathMatch[1];
    }
  } catch (e) {
    console.error('[CrossDrop] Failed to parse URL parameters:', e);
  }
  return null;
}

export default function App() {
  const [step, setStep] = useState<AppStep>('home');
  const [connectionState, setConnectionState] = useState<ConnectionState>('DISCONNECTED');
  const [roomCode, setRoomCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [joinUrl, setJoinUrl] = useState<string>('');
  const [qrSvg, setQrSvg] = useState<string>('');
  const [isAutoJoining, setIsAutoJoining] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [copyCodeSuccess, setCopyCodeSuccess] = useState<boolean>(false);
  const [copyLinkSuccess, setCopyLinkSuccess] = useState<boolean>(false);

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

  // Initialize WebRTC and Signaling services & detect QR join route
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
          setIsAutoJoining(false);
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
          if (prev === 'CONNECTED' || prev === 'TRANSFERRING' || prev === 'COMPLETED') {
            return prev;
          }
          return state;
        });
      },
      // ONLY AFTER server confirms the real room exists, generate the real QR code
      onRoomCreated: async (_id, code) => {
        setRoomCode(code);
        setStep('creating_room');
        setConnectionState('WAITING_FOR_PEER');

        const origin = window.location.origin;
        const realJoinUrl = `${origin}/join?room=${encodeURIComponent(code)}`;
        setJoinUrl(realJoinUrl);

        // Developer logging in development mode
        console.log(`[CrossDrop] QR join URL:\n${realJoinUrl}`);

        try {
          const svg = await generateQRCodeSVG(realJoinUrl, 200);
          setQrSvg(svg);
        } catch (err) {
          console.error('[CrossDrop] Failed to generate QR code SVG:', err);
        }
      },
      onRoomJoined: (_id, _code) => {
        setConnectionState('NEGOTIATING');
        setIsAutoJoining(false);
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
      onError: (code, message) => {
        setIsAutoJoining(false);
        if (code === 'ROOM_NOT_FOUND') {
          setErrorMessage('Room expired or unavailable.');
        } else if (code === 'ROOM_FULL') {
          setErrorMessage('Room is full.');
        } else if (code === 'INVALID_CODE') {
          setErrorMessage('Invalid room code.');
        } else {
          setErrorMessage(message || 'An error occurred.');
        }
        setConnectionState('ERROR');
        setStep('error');
      },
    });

    // Device B auto-detection: Check if opened via QR code or /join?room=XXXXXX
    const codeFromUrl = parseJoinRoomFromUrl();
    if (codeFromUrl) {
      console.log(`[CrossDrop] Detected join room code from URL: ${codeFromUrl}`);
      setInputCode(codeFromUrl);
      setStep('joining_room');
      setIsAutoJoining(true);
      setConnectionState('CONNECTING');

      // Connect to real signaling server and send real join-room request
      (async () => {
        try {
          await signaling.connect();
          signaling.joinRoom(codeFromUrl);
        } catch {
          setErrorMessage('Could not connect to signaling server.');
          setConnectionState('ERROR');
          setStep('error');
          setIsAutoJoining(false);
        }
      })();
    }

    return () => {
      signaling.disconnect();
      webrtc.cleanup();
    };
  }, []);

  const handleCreateRoom = async () => {
    try {
      setErrorMessage('');
      setConnectionState('CONNECTING');
      setQrSvg('');
      setJoinUrl('');
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
      setIsAutoJoining(true);
      if (signalingRef.current) {
        await signalingRef.current.connect();
        signalingRef.current.joinRoom(cleanCode);
      }
    } catch {
      setErrorMessage('Could not connect to signaling server.');
      setConnectionState('ERROR');
      setStep('error');
      setIsAutoJoining(false);
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
    setJoinUrl('');
    setQrSvg('');
    setIsAutoJoining(false);
    setPeerDevice(null);
    setConnectionState('DISCONNECTED');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (signalingRef.current) {
      signalingRef.current.leaveRoom();
    }
    if (webrtcRef.current) {
      webrtcRef.current.cleanup();
    }
    // Clean URL bar back to root path without query parameters
    if (typeof window !== 'undefined' && window.history && (window.location.search || window.location.pathname.startsWith('/join'))) {
      window.history.replaceState({}, '', '/');
    }
    setStep('home');
  };

  const handleCopyCode = () => {
    if (roomCode && navigator.clipboard) {
      navigator.clipboard.writeText(roomCode);
      setCopyCodeSuccess(true);
      setTimeout(() => setCopyCodeSuccess(false), 2000);
    }
  };

  const handleCopyLink = () => {
    if (joinUrl && navigator.clipboard) {
      navigator.clipboard.writeText(joinUrl);
      setCopyLinkSuccess(true);
      setTimeout(() => setCopyLinkSuccess(false), 2000);
    }
  };

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
                setIsAutoJoining(false);
                setStep('joining_room');
              }}
            >
              Join Room
            </button>
          </div>
        </section>
      )}

      {/* Screen 2: Room Created (Real QR Code & 6-Digit Code) */}
      {step === 'creating_room' && (
        <section className="card-section">
          <div className="code-box">
            <span className="code-title">Scan QR code or enter 6-digit code</span>

            {/* Real pairing QR Code (generated only after server confirms room) */}
            {qrSvg ? (
              <div className="qr-box">
                <div
                  className="qr-image-wrapper"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
                <span className="qr-hint">Scan with phone camera to join instantly</span>
              </div>
            ) : (
              <div className="qr-box" style={{ minHeight: '180px' }}>
                <span className="spinner-small" />
                <span className="qr-hint">Creating room and generating QR code...</span>
              </div>
            )}

            <span className="code-digits">{roomCode}</span>

            <div className="btn-group" style={{ marginTop: '0.25rem', width: '100%', justifyContent: 'center' }}>
              <button
                className="btn btn-secondary"
                onClick={handleCopyLink}
                disabled={!joinUrl}
                style={{ width: 'auto', minHeight: '38px', padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}
              >
                {copyLinkSuccess ? '✓ Link Copied!' : '🔗 Copy Join Link'}
              </button>
              <button
                className="btn btn-secondary"
                onClick={handleCopyCode}
                disabled={!roomCode}
                style={{ width: 'auto', minHeight: '38px', padding: '0.45rem 0.9rem', fontSize: '0.85rem' }}
              >
                {copyCodeSuccess ? '✓ Code Copied!' : '📋 Copy Code'}
              </button>
            </div>

            <span className="code-hint">Keep this window open until connected</span>
          </div>

          <button className="btn btn-secondary" onClick={handleFullReset}>
            Cancel
          </button>
        </section>
      )}

      {/* Screen 3: Join Room (Auto-join on QR scan OR manual entry) */}
      {step === 'joining_room' && (
        <section className="card-section">
          {isAutoJoining ? (
            <div className="code-box">
              <span className="code-title">Joining Room</span>
              <span className="code-digits">{inputCode}</span>
              <div className="qr-hint" style={{ marginTop: '0.75rem', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
                <span className="spinner-small" />
                <span>
                  {connectionState === 'WAKING'
                    ? 'Waking server (Render free tier cold start ~30s)...'
                    : connectionState === 'NEGOTIATING'
                    ? 'Negotiating direct P2P link with peer...'
                    : 'Validating room and connecting to server...'}
                </span>
              </div>
              <button
                className="btn btn-secondary"
                style={{ marginTop: '1.25rem' }}
                onClick={() => {
                  setIsAutoJoining(false);
                  handleFullReset();
                }}
              >
                Cancel
              </button>
            </div>
          ) : (
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
                  disabled={inputCode.trim().length !== 6 || connectionState === 'CONNECTING'}
                >
                  {connectionState === 'CONNECTING' ? 'Connecting...' : 'Connect to Device'}
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
          )}
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
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                fileInputRef.current?.click();
              }
            }}
          >
            <div className="drop-zone-icon">📁</div>
            <div className="drop-zone-title">
              {isDragging ? 'Drop files here' : 'Drop files here or click to browse'}
            </div>
            <div className="drop-zone-subtitle">Select single or multiple files to send</div>
          </div>

          {/* Selected Files Queue */}
          {selectedFiles.length > 0 && (
            <div style={{ width: '100%', marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div className="queue-summary">
                <span>Selected: {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''}</span>
                <span>Total: {formatBytes(totalSelectedBytes)}</span>
              </div>

              <div className="file-queue">
                {selectedFiles.map((file, idx) => (
                  <div key={`${file.name}-${idx}`} className="file-queue-item">
                    <span className="file-queue-name" title={file.name}>{file.name}</span>
                    <span className="file-queue-size">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      className="btn-remove-file"
                      title="Remove file"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveFile(idx);
                      }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <div className="btn-group" style={{ marginTop: '0.5rem' }}>
                <button
                  id="send-file-btn"
                  className="btn btn-primary"
                  onClick={handleSendFiles}
                >
                  Send {selectedFiles.length} File{selectedFiles.length > 1 ? 's' : ''}
                </button>
                <button
                  className="btn btn-secondary"
                  onClick={() => setSelectedFiles([])}
                >
                  Clear Selection
                </button>
              </div>
            </div>
          )}

          {/* Received Files List in Connected view */}
          {receivedFiles.length > 0 && selectedFiles.length === 0 && (
            <div style={{ width: '100%', marginTop: '1rem' }}>
              <div className="queue-summary" style={{ marginBottom: '0.5rem' }}>
                <span>Received ({receivedFiles.length})</span>
                {receivedFiles.length > 1 && (
                  <button
                    className="btn-link"
                    style={{ background: 'transparent', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '0.85rem' }}
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

          <div style={{ marginTop: '1rem', width: '100%' }}>
            <button className="btn btn-secondary" onClick={handleFullReset} style={{ width: '100%' }}>
              Leave Room
            </button>
          </div>
        </section>
      )}

      {/* Screen 5: Transferring Files */}
      {step === 'transferring' && progress && (
        <section className="card-section">
          <div className="progress-card">
            <div className="progress-header">
              <span className="progress-title">
                {isSender ? `Sending: ${progress.fileName}` : `Receiving: ${progress.fileName}`}
              </span>
              <span className="progress-percent">{progress.percentage}%</span>
            </div>

            {/* Current File Progress Bar */}
            <div className="progress-bar-bg">
              <div
                className="progress-bar-fill"
                style={{ width: `${progress.percentage}%` }}
              />
            </div>

            {/* File count progress (e.g. File 2 of 5) */}
            {progress.totalFiles > 1 && (
              <div style={{ marginTop: '0.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                  <span>Batch: File {progress.fileIndex + 1} of {progress.totalFiles}</span>
                  <span>Overall: {Math.round(((progress.fileIndex + progress.percentage / 100) / progress.totalFiles) * 100)}%</span>
                </div>
                <div className="progress-bar-bg" style={{ height: '6px', marginTop: '0.25rem' }}>
                  <div
                    className="progress-bar-fill"
                    style={{
                      width: `${Math.round(((progress.fileIndex + progress.percentage / 100) / progress.totalFiles) * 100)}%`,
                      background: '#10b981',
                    }}
                  />
                </div>
              </div>
            )}

            {/* Metrics Row: Speed, ETA & Bytes */}
            <div className="metrics-row">
              <div className="metric-badge">
                <span>⚡</span>
                <span className="metric-value">
                  {progress.speedBytesPerSec ? formatBytes(progress.speedBytesPerSec) + '/s' : '-- MB/s'}
                </span>
              </div>
              <div className="metric-badge">
                <span>⏱</span>
                <span>{formatEta(progress.etaSeconds)}</span>
              </div>
              <div className="metric-badge">
                <span>{formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)}</span>
              </div>
            </div>
          </div>

          <button
            id="cancel-transfer-btn"
            className="btn btn-danger"
            onClick={handleCancelTransfer}
            style={{ marginTop: '0.5rem' }}
          >
            Cancel Transfer
          </button>
        </section>
      )}

      {/* Screen 6: Completed Transfer */}
      {step === 'completed' && (
        <section className="card-section">
          <div className="success-box">
            <span className="success-icon">✓</span>
            <span className="success-title">
              {isSender ? 'Files Sent Successfully!' : 'Files Received Successfully!'}
            </span>
            <span className="success-desc">
              Transferred directly between devices over WebRTC
            </span>

            {/* Download Queue for Received Files */}
            {!isSender && receivedFiles.length > 0 && (
              <div style={{ width: '100%', marginTop: '1rem' }}>
                <div className="queue-summary" style={{ marginBottom: '0.5rem' }}>
                  <span>Files ({receivedFiles.length})</span>
                  {receivedFiles.length > 1 && (
                    <button
                      className="btn-link"
                      style={{ background: 'transparent', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '0.85rem' }}
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
        <div className="status-banner error" style={{ wordBreak: 'break-word', marginTop: '1rem' }}>
          <span>{errorMessage}</span>
        </div>
      )}

      {/* Error Screen Actions */}
      {step === 'error' && (
        <section className="card-section">
          <div className="btn-group" style={{ marginTop: '0.5rem' }}>
            <button
              className="btn btn-primary"
              onClick={() => {
                handleFullReset();
                handleCreateRoom();
              }}
            >
              Create New Room
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                handleFullReset();
                setStep('joining_room');
              }}
            >
              Join Another Room
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
