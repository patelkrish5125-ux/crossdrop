import React, { useState, useEffect, useRef } from 'react';
import type {
  ConnectionState,
  ReceivedFile,
  TransferProgress,
} from './types/index.ts';
import { SignalingClient } from './services/signaling.ts';
import { WebRTCService } from './services/webrtc.ts';
import { getSignalingConfig } from './config.ts';

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

export default function App() {
  const [step, setStep] = useState<AppStep>('home');
  const [connectionState, setConnectionState] = useState<ConnectionState>('Disconnected');
  const [roomCode, setRoomCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [errorMessage, setErrorMessage] = useState<string>('');

  // File state
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [receivedFile, setReceivedFile] = useState<ReceivedFile | null>(null);
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [isSender, setIsSender] = useState<boolean>(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const webrtcRef = useRef<WebRTCService | null>(null);

  // Initialize WebRTC and Signaling services
  useEffect(() => {
    console.log('[CrossDrop] Secure context:', window.isSecureContext);
    const config = getSignalingConfig();
    if (config.isConfigured) {
      console.log(`[CrossDrop] Signaling URL: ${config.url}`);
    } else {
      console.error('[CrossDrop] Signaling URL: NOT CONFIGURED (Missing VITE_SIGNALING_URL in production build)');
    }
    const signaling = new SignalingClient();
    signalingRef.current = signaling;

    const webrtc = new WebRTCService((signal) => {
      signaling.sendSignal(signal);
    });
    webrtcRef.current = webrtc;

    // WebRTC Callbacks
    webrtc.setCallbacks({
      onConnectionStateChange: (state) => {
        setConnectionState(state);
        if (state === 'Connected') {
          setStep((prev) => (prev === 'transferring' || prev === 'completed' ? prev : 'connected'));
        } else if (state === 'Disconnected') {
          setErrorMessage('Peer device disconnected.');
          setStep('error');
        } else if (state === 'Error') {
          setStep('error');
        }
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
        setReceivedFile(file);
        setIsSender(false);
      },
      onError: (err) => {
        setErrorMessage(err);
        setStep('error');
      },
    });

    // Signaling Callbacks
    signaling.setCallbacks({
      onRoomCreated: (_id, code) => {
        setRoomCode(code);
        setStep('creating_room');
        setConnectionState('Connecting');
      },
      onRoomJoined: (_id, _code) => {
        setConnectionState('Connecting');
        webrtc.initConnection(false); // Joiner waits for offer
      },
      onPeerJoined: () => {
        setConnectionState('Connecting');
        webrtc.initConnection(true); // Creator initiates offer
      },
      onSignal: (signalData) => {
        webrtc.handleSignal(signalData);
      },
      onPeerDisconnected: (reason) => {
        setErrorMessage(reason || 'Device disconnected.');
        setConnectionState('Disconnected');
        setStep('error');
        webrtc.cleanup();
      },
      onConnectionChange: (connected, statusText) => {
        if (!connected) {
          setConnectionState('Disconnected');
        } else {
          console.log('[CrossDrop App] Signaling status:', statusText);
        }
      },
      onStatusChange: (status, statusText) => {
        if (status === 'waking') {
          setConnectionState('Waking');
        } else if (status === 'connecting') {
          setConnectionState('Connecting');
        }
        console.log('[CrossDrop App] Status changed:', status, statusText);
      },
      onError: (_code, message) => {
        setErrorMessage(message);
        setConnectionState('Disconnected');
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
      setConnectionState('Connecting');
      if (signalingRef.current) {
        await signalingRef.current.connect();
        signalingRef.current.createRoom();
      }
    } catch {
      setErrorMessage('Could not connect to signaling server.');
      setConnectionState('Disconnected');
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
      setConnectionState('Connecting');
      if (signalingRef.current) {
        await signalingRef.current.connect();
        signalingRef.current.joinRoom(cleanCode);
      }
    } catch {
      setErrorMessage('Could not connect to signaling server.');
      setConnectionState('Disconnected');
      setStep('error');
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      setSelectedFile(e.target.files[0]);
    }
  };

  const handleSendFile = async () => {
    if (!selectedFile || !webrtcRef.current) return;
    setIsSender(true);
    setStep('transferring');
    try {
      await webrtcRef.current.sendFile(selectedFile);
    } catch (err: any) {
      setErrorMessage(err.message || 'File transfer failed.');
      setStep('error');
    }
  };

  const handleCancelTransfer = () => {
    if (webrtcRef.current) {
      webrtcRef.current.cancelTransfer();
    }
  };

  const handleDownload = () => {
    if (!receivedFile) return;
    const a = document.createElement('a');
    a.href = receivedFile.url;
    a.download = receivedFile.name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleResetForNextFile = () => {
    setSelectedFile(null);
    setReceivedFile(null);
    setProgress(null);
    setErrorMessage('');
    if (fileInputRef.current) fileInputRef.current.value = '';
    setStep('connected');
  };

  const handleFullReset = () => {
    setSelectedFile(null);
    setReceivedFile(null);
    setProgress(null);
    setErrorMessage('');
    setRoomCode('');
    setInputCode('');
    setConnectionState('Disconnected');
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (signalingRef.current) {
      signalingRef.current.leaveRoom();
    }
    if (webrtcRef.current) {
      webrtcRef.current.cleanup();
    }
    setStep('home');
  };

  return (
    <main className="app-container">
      {/* App Header */}
      <header className="app-header">
        <h1 className="app-title">
          CrossDrop <span className="app-badge">Phase 1</span>
        </h1>
        <p className="app-subtitle">Send files directly between your devices</p>
        <div
          id="secure-context-badge"
          style={{
            marginTop: '0.5rem',
            fontSize: '0.75rem',
            fontWeight: 500,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '0.35rem',
            padding: '0.2rem 0.6rem',
            borderRadius: '12px',
            backgroundColor: window.isSecureContext ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
            color: window.isSecureContext ? '#10b981' : '#f59e0b',
            border: `1px solid ${window.isSecureContext ? 'rgba(16, 185, 129, 0.3)' : 'rgba(245, 158, 11, 0.3)'}`,
          }}
        >
          <span>{window.isSecureContext ? '🔒' : '⚠️'}</span>
          <span>Secure context: {window.isSecureContext ? 'true' : 'false'}</span>
        </div>
      </header>

      {/* Active Connection State Banner */}
      {step !== 'home' && step !== 'joining_room' && (
        <div
          className={`status-banner ${
            connectionState === 'Connected'
              ? 'connected'
              : connectionState === 'Connecting' || connectionState === 'Waking'
              ? 'connecting'
              : 'error'
          }`}
        >
          <span className="status-dot" />
          <span>
            {connectionState === 'Connected'
              ? '✓ Connected'
              : connectionState === 'Waking'
              ? '⏳ Waking server (Render free tier cold start ~30s)...'
              : connectionState === 'Connecting'
              ? 'Connecting...'
              : connectionState}
          </span>
        </div>
      )}

      {/* Global Waking Indicator when on Home or Joining Screen */}
      {connectionState === 'Waking' && (step === 'home' || step === 'joining_room') && (
        <div className="status-banner connecting" style={{ marginBottom: '1rem' }}>
          <span className="status-dot" />
          <span>⏳ Waking server (Render free tier cold start ~30s)... please wait</span>
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

      {/* Screen 2: Room Created (Waiting for Peer) */}
      {step === 'creating_room' && (
        <section className="card-section">
          <div className="code-box">
            <span className="code-title">Your pairing code</span>
            <span className="code-digits">{roomCode}</span>
            <span className="code-hint">Waiting for another device to connect...</span>
          </div>
          <button className="btn btn-secondary" onClick={handleFullReset}>
            Cancel
          </button>
        </section>
      )}

      {/* Screen 3: Join Room (Numeric Keypad on Mobile) */}
      {step === 'joining_room' && (
        <form className="card-section" onSubmit={handleJoinRoom}>
          <div className="input-group">
            <label htmlFor="pairing-code" className="input-label">
              Enter 6-digit pairing code
            </label>
            <input
              id="pairing-code"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="000000"
              autoFocus
              className="code-input"
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <div className="btn-group">
            <button
              id="connect-btn"
              type="submit"
              className="btn btn-primary"
              disabled={inputCode.trim().length !== 6}
            >
              Connect
            </button>
            <button type="button" className="btn btn-secondary" onClick={handleFullReset}>
              Back
            </button>
          </div>
        </form>
      )}

      {/* Screen 4: Connected (Mobile-Optimized File Picker & Send) */}
      {step === 'connected' && (
        <section className="card-section">
          <p className="section-label">Send a file</p>

          {/* Offscreen native file input */}
          <input
            id="file-input"
            ref={fileInputRef}
            type="file"
            className="sr-only-input"
            onChange={handleFileSelect}
          />

          {!selectedFile ? (
            <div className="btn-group">
              {/* Native label trigger ensures reliable tap on Android Chrome */}
              <label htmlFor="file-input" id="choose-file-btn" className="btn btn-primary">
                Choose File
              </label>
              <button className="btn btn-secondary" onClick={handleFullReset}>
                Disconnect
              </button>
            </div>
          ) : (
            <>
              {/* File Info Card with clean truncation */}
              <div className="file-card">
                <div className="file-info">
                  <span className="file-name" title={selectedFile.name}>
                    {selectedFile.name}
                  </span>
                  <span className="file-size">{formatBytes(selectedFile.size)}</span>
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-change-file"
                  onClick={() => {
                    setSelectedFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  }}
                >
                  Change
                </button>
              </div>

              <div className="btn-group">
                <button id="send-file-btn" className="btn btn-primary" onClick={handleSendFile}>
                  Send File
                </button>
                <button className="btn btn-secondary" onClick={handleFullReset}>
                  Disconnect
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {/* Screen 5: Transferring (Real-time Progress) */}
      {step === 'transferring' && progress && (
        <section className="card-section">
          <div className="progress-card">
            <div className="progress-header">
              <span className="progress-title" title={progress.fileName}>
                {progress.status === 'sending' ? `Sending ${progress.fileName}` : `Receiving ${progress.fileName}`}
              </span>
              <span className="progress-percent">{progress.percentage}%</span>
            </div>

            <div className="progress-bar-bg">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.max(0, Math.min(100, progress.percentage))}%` }}
              />
            </div>

            <div className="progress-footer">
              <span>
                {formatBytes(progress.transferredBytes)} / {formatBytes(progress.totalBytes)}
              </span>
              <span>{progress.status.charAt(0).toUpperCase() + progress.status.slice(1)}</span>
            </div>
          </div>

          <button className="btn btn-danger" onClick={handleCancelTransfer}>
            Cancel Transfer
          </button>
        </section>
      )}

      {/* Screen 6: Completed (Download & Reset) */}
      {step === 'completed' && (
        <section className="card-section">
          {isSender ? (
            <div className="success-box">
              <div className="success-icon">✓</div>
              <h3 className="success-title">File sent successfully!</h3>
              {selectedFile && (
                <p className="file-size">
                  {selectedFile.name} ({formatBytes(selectedFile.size)})
                </p>
              )}
              <div className="btn-group">
                <button className="btn btn-primary" onClick={handleResetForNextFile}>
                  Send Another File
                </button>
                <button className="btn btn-secondary" onClick={handleFullReset}>
                  Disconnect
                </button>
              </div>
            </div>
          ) : (
            <div className="success-box">
              <div className="success-icon">✓</div>
              <h3 className="success-title">Transfer complete</h3>
              {receivedFile && (
                <div className="file-info" style={{ textAlign: 'center', width: '100%' }}>
                  <span className="file-name" style={{ textAlign: 'center' }}>
                    {receivedFile.name}
                  </span>
                  <span className="file-size">{formatBytes(receivedFile.size)}</span>
                </div>
              )}
              <div className="btn-group">
                <button id="download-btn" className="btn btn-success" onClick={handleDownload}>
                  Download File
                </button>
                <button className="btn btn-secondary" onClick={handleResetForNextFile}>
                  Ready for Next File
                </button>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Screen 7: Error State */}
      {step === 'error' && (
        <section className="card-section">
          <div className="status-banner error">
            <span className="status-dot" />
            <span>{errorMessage || 'An error occurred.'}</span>
          </div>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={handleFullReset}>
              Create New Room
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => {
                handleFullReset();
                setStep('joining_room');
              }}
            >
              Join Room
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
