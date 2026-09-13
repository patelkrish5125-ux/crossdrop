import React, { useState, useEffect, useRef } from 'react';
import type {
  ConnectionState,
  ReceivedFile,
  RemotePeer,
  SessionHistoryItem,
  TransferProgress,
  TransferQueueItem,
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
  if (/android/i.test(ua)) return 'Android Phone';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iPhone / iPad';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac Laptop';
  if (/Windows NT/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'Browser Device';
}

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

  // Device naming & multi-peer presence
  const [deviceName, setDeviceName] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('crossdrop_device_name');
      if (saved && saved.trim()) return saved.trim();
    }
    return getDefaultDeviceName();
  });
  const [remotePeers, setRemotePeers] = useState<RemotePeer[]>([]);
  const [selectedTargetPeerId, setSelectedTargetPeerId] = useState<string>('');

  // Transfer queue & state
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [transferQueue, setTransferQueue] = useState<TransferQueueItem[]>([]);
  const [receivedFiles, setReceivedFiles] = useState<ReceivedFile[]>([]);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryItem[]>([]);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const [folderNotice, setFolderNotice] = useState<string>('');

  // Folder transfer support detection
  const isFolderSupported = typeof window !== 'undefined' && 'webkitdirectory' in document.createElement('input');

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCService | null>(null);

  const handleDeviceNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newName = e.target.value;
    setDeviceName(newName);
    if (typeof window !== 'undefined') {
      localStorage.setItem('crossdrop_device_name', newName);
    }
    webrtcRef.current?.setDeviceName(newName);
  };

  useEffect(() => {
    const config = getSignalingConfig();
    if (config.isConfigured) {
      console.log(`[CrossDrop] Signaling URL: ${config.url}`);
    }

    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    const webrtc = new WebRTCService((signal, targetPeerId) => {
      signaling.sendSignal(signal, targetPeerId);
    });
    webrtc.setDeviceName(deviceName);
    webrtcRef.current = webrtc;

    webrtc.setCallbacks({
      onConnectionStateChange: (state) => {
        setConnectionState(state);
        if (state === 'CONNECTED') {
          setIsAutoJoining(false);
          setStep('connected');
        } else if (state === 'DISCONNECTED') {
          // If all peers disconnected
          if (webrtc.getConnectedPeers().length === 0) {
            setErrorMessage('Peer device disconnected.');
          }
        } else if (state === 'ERROR') {
          setStep('error');
        }
      },
      onPeerListUpdate: (peers) => {
        setRemotePeers(peers);
        // Auto-select first connected peer if none selected
        if (!selectedTargetPeerId && peers.length > 0) {
          const firstConnected = peers.find((p) => p.status === 'connected') || peers[0];
          setSelectedTargetPeerId(firstConnected.id);
        }
      },
      onProgress: (p) => {
        setProgress(p);
      },
      onQueueUpdate: (queue) => {
        setTransferQueue(queue);
      },
      onFileReceived: (file) => {
        setReceivedFiles((prev) => [file, ...prev]);
      },
      onSessionHistory: (history) => {
        setSessionHistory(history);
      },
      onError: (err) => {
        setErrorMessage(err);
      },
    });

    signaling.setCallbacks({
      onStateChange: (state) => {
        setConnectionState((prev) => {
          if (prev === 'CONNECTED' && state === 'SIGNALING_CONNECTED') return prev;
          return state;
        });
      },
      onRoomCreated: async (_id, code, myPeerId) => {
        setRoomCode(code);
        setStep('creating_room');
        setConnectionState('WAITING_FOR_PEER');
        if (myPeerId) webrtc.setLocalPeerId(myPeerId);

        const origin = window.location.origin;
        const realJoinUrl = `${origin}/join?room=${encodeURIComponent(code)}`;
        setJoinUrl(realJoinUrl);
        console.log(`[CrossDrop] QR join URL:\n${realJoinUrl}`);

        try {
          const svg = await generateQRCodeSVG(realJoinUrl, 200);
          setQrSvg(svg);
        } catch (err) {
          console.error('[CrossDrop] Failed to generate QR SVG:', err);
        }
      },
      onRoomJoined: (_id, _code, myPeerId, existingPeers) => {
        setConnectionState('NEGOTIATING');
        setIsAutoJoining(false);
        if (myPeerId) webrtc.setLocalPeerId(myPeerId);

        if (existingPeers && existingPeers.length > 0) {
          for (const peer of existingPeers) {
            webrtc.addPeerFromRoom(peer.id, peer.name, peer.role);
            // Joiner initiates WebRTC connection to existing peers in room
            webrtc.initConnection(true, peer.id);
          }
        }
      },
      onPeerJoined: (peer) => {
        if (peer) {
          webrtc.addPeerFromRoom(peer.id, peer.name, peer.role);
          // Wait for incoming connection offer from new peer
          webrtc.initConnection(false, peer.id);
        }
      },
      onPeerLeft: (peerId) => {
        webrtc.removePeer(peerId);
      },
      onSignal: (signalData, senderPeerId) => {
        webrtc.handleSignal(signalData, senderPeerId);
      },
      onPeerDisconnected: (reason, peerId) => {
        if (peerId) {
          webrtc.removePeer(peerId);
        }
        if (reason) setErrorMessage(reason);
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

    // Auto-detect /join?room=XXXXXX
    const codeFromUrl = parseJoinRoomFromUrl();
    if (codeFromUrl) {
      console.log(`[CrossDrop] Detected join room code from URL: ${codeFromUrl}`);
      setInputCode(codeFromUrl);
      setStep('joining_room');
      setIsAutoJoining(true);
      setConnectionState('CONNECTING');

      (async () => {
        try {
          await signaling.connect();
          signaling.joinRoom(codeFromUrl, deviceName);
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
        signalingRef.current.createRoom(deviceName);
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
        signalingRef.current.joinRoom(cleanCode, deviceName);
      }
    } catch {
      setErrorMessage('Could not connect to signaling server.');
      setConnectionState('ERROR');
      setStep('error');
      setIsAutoJoining(false);
    }
  };

  // File & Folder selection handlers
  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const filesArray = Array.from(e.target.files);
      setSelectedFiles((prev) => [...prev, ...filesArray]);
      setErrorMessage('');
      setFolderNotice('');
    }
  };

  const handleFolderSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const filesArray = Array.from(e.target.files);
      setSelectedFiles((prev) => [...prev, ...filesArray]);
      setErrorMessage('');
      setFolderNotice(`Added folder with ${filesArray.length} files (structure preserved).`);
    }
  };

  const handleTriggerFolderPicker = () => {
    if (!isFolderSupported) {
      setFolderNotice('Folder selection is not supported on this mobile browser. Please use "Add Files" instead.');
      return;
    }
    folderInputRef.current?.click();
  };

  const handleRemoveSelectedFile = (index: number) => {
    setSelectedFiles((prev) => prev.filter((_, i) => i !== index));
  };

  // Drag & Drop handlers
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
      setSelectedFiles((prev) => [...prev, ...filesArray]);
      setErrorMessage('');
    }
  };

  // Start sending files via bounded queue
  const handleSendSelectedFiles = () => {
    if (selectedFiles.length === 0 || !webrtcRef.current) return;
    webrtcRef.current.addFilesToQueue(selectedFiles, selectedTargetPeerId || undefined);
    setSelectedFiles([]);
    setFolderNotice('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
  };

  // Queue controls
  const handlePauseTransfer = (transferId: string) => {
    webrtcRef.current?.pauseTransfer(transferId);
  };

  const handleResumeTransfer = (transferId: string) => {
    webrtcRef.current?.resumeTransfer(transferId);
  };

  const handleCancelTransfer = (transferId: string) => {
    webrtcRef.current?.cancelTransfer(transferId);
  };

  const handleRetryTransfer = (transferId: string) => {
    webrtcRef.current?.retryTransfer(transferId);
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

  const handleFullReset = () => {
    setSelectedFiles([]);
    setTransferQueue([]);
    setReceivedFiles([]);
    setProgress(null);
    setErrorMessage('');
    setFolderNotice('');
    setRoomCode('');
    setInputCode('');
    setJoinUrl('');
    setQrSvg('');
    setIsAutoJoining(false);
    setRemotePeers([]);
    setConnectionState('DISCONNECTED');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (folderInputRef.current) folderInputRef.current.value = '';
    if (signalingRef.current) signalingRef.current.leaveRoom();
    if (webrtcRef.current) webrtcRef.current.cleanup();
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
  const activeTransfers = transferQueue.filter((q) => q.status === 'transferring' || q.status === 'receiving');
  const connectedPeerCount = remotePeers.filter((p) => p.status === 'connected').length;

  return (
    <main className="app-container">
      {/* App Header */}
      <header className="app-header">
        <h1 className="app-title">
          CrossDrop <span className="app-badge">Phase 3</span>
        </h1>
        <p className="app-subtitle">High-speed, multi-device peer-to-peer file sharing</p>

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
              title="Click to change your device name"
              maxLength={24}
            />
          </div>
          {roomCode && (
            <div className="peer-badge" title="Room Code">
              <span>🔑 Room: {roomCode}</span>
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
              ? `✓ Connected (${connectedPeerCount} device${connectedPeerCount === 1 ? '' : 's'} in room)`
              : connectionState === 'WAKING'
              ? '⏳ Waking server (Render free tier cold start ~30s)...'
              : connectionState === 'WAITING_FOR_PEER'
              ? 'Waiting for devices to connect...'
              : connectionState === 'NEGOTIATING'
              ? 'Establishing P2P link with devices...'
              : connectionState === 'RECONNECTING'
              ? '🔄 Reconnecting to signaling server...'
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
            <span className="code-title">Scan QR code or enter 6-digit code to join</span>

            {qrSvg ? (
              <div className="qr-box">
                <div
                  className="qr-image-wrapper"
                  dangerouslySetInnerHTML={{ __html: qrSvg }}
                />
                <span className="qr-hint">Scan with camera to connect any phone, tablet, or laptop</span>
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

            <span className="code-hint">Multiple devices can join simultaneously</span>
          </div>

          <div className="btn-group">
            <button className="btn btn-primary" onClick={() => setStep('connected')}>
              Go to Transfer Dashboard
            </button>
            <button className="btn btn-secondary" onClick={handleFullReset}>
              Leave Room
            </button>
          </div>
        </section>
      )}

      {/* Screen 3: Join Room */}
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
                    ? 'Negotiating direct P2P link...'
                    : 'Validating room and connecting...'}
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
                  {connectionState === 'CONNECTING' ? 'Connecting...' : 'Connect to Room'}
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

      {/* Screen 4: Phase 3 Connected Dashboard */}
      {step === 'connected' && (
        <section className="card-section">
          {/* Multi-Peer Presence & Target Destination Selector */}
          <div className="peers-section">
            <div className="peers-header">
              <span>Connected Devices ({remotePeers.length})</span>
              <button
                className="btn-link"
                style={{ background: 'transparent', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '0.8rem' }}
                onClick={() => setStep('creating_room')}
              >
                + Show QR to Add Devices
              </button>
            </div>
            <div className="peers-grid">
              {remotePeers.length === 0 ? (
                <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                  No other devices connected yet. Share code <strong>{roomCode}</strong> or scan QR code.
                </span>
              ) : (
                remotePeers.map((peer) => (
                  <div
                    key={peer.id}
                    className={`peer-chip ${selectedTargetPeerId === peer.id ? 'selected' : ''}`}
                    onClick={() => setSelectedTargetPeerId(peer.id)}
                    title={`Click to target ${peer.name}`}
                  >
                    <span className={`presence-dot ${peer.status}`} />
                    <span>{peer.name}</span>
                    {selectedTargetPeerId === peer.id && <span style={{ fontSize: '0.75rem', color: '#60a5fa' }}>★ Target</span>}
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Real-time Overall Throughput Banner */}
          {progress && activeTransfers.length > 0 && (
            <div className="dashboard-metrics" style={{ marginTop: '0.75rem' }}>
              <div className="dashboard-speed-hero">
                <span className="speed-hero-value">
                  {progress.speedBytesPerSec ? (progress.speedBytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s' : '-- MB/s'}
                </span>
                <span className="speed-hero-label">Real Measured Throughput</span>
              </div>
              <div style={{ textAlign: 'right', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                <div>ETA: <strong>{formatEta(progress.etaSeconds)}</strong></div>
                <div>{formatBytes(progress.overallTransferredBytes)} / {formatBytes(progress.overallTotalBytes)} ({progress.overallPercentage}%)</div>
              </div>
            </div>
          )}

          {/* Hidden inputs for Files and Folders */}
          <input
            type="file"
            multiple
            ref={fileInputRef}
            onChange={handleFileSelect}
            className="sr-only-input"
            id="file-selector-input"
          />
          <input
            type="file"
            ref={folderInputRef}
            onChange={handleFolderSelect}
            className="sr-only-input"
            id="folder-selector-input"
            {...({ webkitdirectory: '', directory: '', multiple: true } as any)}
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
            <div className="drop-zone-icon">🚀</div>
            <div className="drop-zone-title">
              {isDragging ? 'Drop files or folders here' : 'Drop files or folders to send'}
            </div>
            <div className="drop-zone-subtitle">High-speed 64 KB streaming with SHA-256 integrity</div>
          </div>

          {/* Selection Action Buttons */}
          <div className="btn-group" style={{ marginTop: '0.5rem' }}>
            <button
              className="btn btn-secondary"
              onClick={() => fileInputRef.current?.click()}
              style={{ flex: 1 }}
            >
              📄 Add Files
            </button>
            <button
              className="btn btn-secondary"
              onClick={handleTriggerFolderPicker}
              style={{ flex: 1 }}
              title={isFolderSupported ? 'Upload entire directory structure' : 'Folder upload requires desktop browser'}
            >
              📁 Add Folder
            </button>
          </div>

          {folderNotice && (
            <div className="qr-hint" style={{ color: '#c084fc', textAlign: 'center', marginTop: '0.25rem' }}>
              {folderNotice}
            </div>
          )}

          {/* Selected Files Staging List */}
          {selectedFiles.length > 0 && (
            <div style={{ width: '100%', marginTop: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              <div className="queue-summary">
                <span>Selected: {selectedFiles.length} file{selectedFiles.length > 1 ? 's' : ''}</span>
                <span>Total: {formatBytes(totalSelectedBytes)}</span>
              </div>

              <div className="file-queue">
                {selectedFiles.map((file, idx) => (
                  <div key={`${file.name}-${idx}`} className="file-queue-item">
                    <span className="file-queue-name" title={file.name}>
                      {(file as any).webkitRelativePath ? (
                        <span className="folder-badge">{(file as any).webkitRelativePath.split('/')[0]}</span>
                      ) : null}
                      {file.name}
                    </span>
                    <span className="file-queue-size">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      className="btn-remove-file"
                      title="Remove file"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRemoveSelectedFile(idx);
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
                  onClick={handleSendSelectedFiles}
                >
                  Send {selectedFiles.length} Item{selectedFiles.length > 1 ? 's' : ''} to{' '}
                  {remotePeers.find((p) => p.id === selectedTargetPeerId)?.name || 'Peer'}
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

          {/* Concurrent Transfer Queue */}
          {transferQueue.length > 0 && (
            <div style={{ width: '100%', marginTop: '1rem' }}>
              <div className="queue-summary" style={{ marginBottom: '0.5rem' }}>
                <span>Transfer Queue ({transferQueue.length})</span>
                <button
                  className="btn-link"
                  style={{ background: 'transparent', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: '0.8rem' }}
                  onClick={() => webrtcRef.current?.cancelTransfer()}
                >
                  Cancel All
                </button>
              </div>

              <div className="queue-items-container">
                {transferQueue.map((item) => (
                  <div key={item.id} className="queue-card">
                    <div className="queue-card-top">
                      <span className="queue-card-name" title={item.name}>
                        {item.relativePath ? (
                          <span className="folder-badge">{item.relativePath.split('/')[0]}</span>
                        ) : null}
                        {item.name}
                      </span>
                      <span className={`queue-card-status ${item.status}`}>
                        {item.status === 'completed' ? (
                          <span>✓ Done {item.integrityVerified ? '(SHA-256 ✓)' : ''}</span>
                        ) : item.status === 'transferring' ? (
                          <span>{item.percentage}% ({item.speedBytesPerSec ? (item.speedBytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s' : '--'})</span>
                        ) : item.status === 'receiving' ? (
                          <span>{item.percentage}% ({item.speedBytesPerSec ? (item.speedBytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s' : '--'})</span>
                        ) : item.status === 'paused' ? (
                          <span>⏸ Paused</span>
                        ) : item.status === 'waiting' ? (
                          <span>⏳ Waiting</span>
                        ) : item.status === 'cancelled' ? (
                          <span>✕ Cancelled</span>
                        ) : (
                          <span>⚠️ Failed</span>
                        )}
                      </span>
                    </div>

                    {/* Progress Bar */}
                    <div className="progress-bar-bg" style={{ height: '8px' }}>
                      <div
                        className="progress-bar-fill"
                        style={{
                          width: `${item.percentage}%`,
                          background: item.status === 'completed' ? '#10b981' : item.status === 'paused' ? '#f59e0b' : '#3b82f6',
                        }}
                      />
                    </div>

                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                      <span>{formatBytes(item.transferredBytes)} / {formatBytes(item.size)} • {item.direction === 'send' ? `To: ${item.targetPeerName}` : `From: ${item.targetPeerName}`}</span>

                      {/* Action buttons per file */}
                      <div className="queue-card-actions">
                        {item.status === 'transferring' && (
                          <button className="btn-icon-sm" onClick={() => handlePauseTransfer(item.transferId)} title="Pause">
                            ⏸
                          </button>
                        )}
                        {item.status === 'paused' && (
                          <button className="btn-icon-sm" onClick={() => handleResumeTransfer(item.transferId)} title="Resume">
                            ▶
                          </button>
                        )}
                        {(item.status === 'transferring' || item.status === 'waiting' || item.status === 'paused') && (
                          <button className="btn-icon-sm danger" onClick={() => handleCancelTransfer(item.transferId)} title="Cancel">
                            ✕
                          </button>
                        )}
                        {item.status === 'failed' && (
                          <button className="btn-icon-sm" onClick={() => handleRetryTransfer(item.transferId)} title="Retry">
                            ↻ Retry
                          </button>
                        )}
                        {item.status === 'completed' && item.downloadUrl && (
                          <button
                            className="btn-icon-sm"
                            style={{ background: 'rgba(16, 185, 129, 0.2)', color: '#34d399', borderColor: 'rgba(16, 185, 129, 0.4)' }}
                            onClick={() => {
                              const a = document.createElement('a');
                              a.href = item.downloadUrl!;
                              a.download = item.name;
                              a.click();
                            }}
                          >
                            💾 Save
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Received Files Downloads List */}
          {receivedFiles.length > 0 && (
            <div style={{ width: '100%', marginTop: '1rem' }}>
              <div className="queue-summary" style={{ marginBottom: '0.5rem' }}>
                <span>Received Files ({receivedFiles.length})</span>
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
                      <span className="received-item-name" title={file.name}>
                        {file.relativePath ? (
                          <span className="folder-badge">{file.relativePath.split('/')[0]}</span>
                        ) : null}
                        {file.name}
                      </span>
                      <span className="received-item-size">
                        {formatBytes(file.size)} • {file.senderName || 'Peer'}
                        {file.integrityVerified && (
                          <span className="badge-integrity verified" style={{ marginLeft: '0.5rem' }}>
                            SHA-256 ✓
                          </span>
                        )}
                      </span>
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

          {/* Session Transfer History */}
          {sessionHistory.length > 0 && (
            <div className="history-section">
              <div className="history-title">
                <span>Session Transfer History</span>
                <span style={{ fontSize: '0.75rem', fontWeight: 'normal' }}>Current session only</span>
              </div>
              <div className="history-table-wrapper">
                <table className="history-table">
                  <thead>
                    <tr>
                      <th>File</th>
                      <th>Size</th>
                      <th>Direction</th>
                      <th>Device</th>
                      <th>Throughput</th>
                      <th>Integrity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessionHistory.map((item) => (
                      <tr key={item.id}>
                        <td style={{ maxWidth: '140px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.fileName}
                        </td>
                        <td>{formatBytes(item.size)}</td>
                        <td>{item.direction === 'sent' ? '↗ Sent' : '↙ Received'}</td>
                        <td>{item.peerName}</td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>
                          {(item.speedBytesPerSec / (1024 * 1024)).toFixed(2)} MB/s
                        </td>
                        <td>
                          {item.integrityVerified ? (
                            <span className="badge-integrity verified">Verified ✓</span>
                          ) : (
                            <span className="badge-integrity mismatch">Mismatch ⚠️</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ marginTop: '1.25rem', width: '100%' }}>
            <button className="btn btn-secondary" onClick={handleFullReset} style={{ width: '100%' }}>
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
