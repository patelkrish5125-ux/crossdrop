// Background execution manager for CrossDrop
// Prevents tab sleep, CPU throttling, and socket freezes when minimized or in the background.

class BackgroundTransferManager {
  private wakeLock: any = null;
  private worker: Worker | null = null;
  private audioCtx: AudioContext | null = null;
  private silentSource: AudioBufferSourceNode | null = null;
  private isRunning = false;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.isRunning) {
          this.acquireWakeLock();
        }
      });
    }
  }

  /**
   * Activates all background transfer protections:
   * 1. Screen Wake Lock
   * 2. Web Worker Heartbeat
   * 3. Silent Web Audio loop (prevents mobile/Chromium background tab throttling)
   */
  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // 1. Screen Wake Lock
    await this.acquireWakeLock();

    // 2. Web Worker Heartbeat (un-throttled background timer)
    this.startWorkerHeartbeat();

    // 3. Silent Audio Keep-Alive
    this.startSilentAudio();

    // 4. Request notification permission if not yet decided
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      try {
        Notification.requestPermission().catch(() => {});
      } catch {}
    }
  }

  /**
   * Deactivates background protections when all transfers complete or are cancelled.
   */
  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.releaseWakeLock();
    this.stopWorkerHeartbeat();
    this.stopSilentAudio();
  }

  private async acquireWakeLock(): Promise<void> {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        this.wakeLock = await (navigator as any).wakeLock.request('screen');
        this.wakeLock.addEventListener('release', () => {
          this.wakeLock = null;
        });
      } catch {
        // Silently ignore if denied or unsupported
      }
    }
  }

  private releaseWakeLock(): void {
    if (this.wakeLock) {
      try {
        this.wakeLock.release().catch(() => {});
      } catch {}
      this.wakeLock = null;
    }
  }

  private startWorkerHeartbeat(): void {
    if (this.worker) return;
    try {
      // Inline Web Worker code: runs interval outside main thread DOM throttling
      const blob = new Blob(
        [
          `
          let timer = null;
          self.onmessage = function(e) {
            if (e.data === 'start') {
              if (!timer) {
                timer = setInterval(function() {
                  self.postMessage('tick');
                }, 25);
              }
            } else if (e.data === 'stop') {
              if (timer) {
                clearInterval(timer);
                timer = null;
              }
            }
          };
        `,
        ],
        { type: 'application/javascript' }
      );
      const url = URL.createObjectURL(blob);
      this.worker = new Worker(url);
      this.worker.onmessage = () => {
        // Heartbeat tick keeps the main event loop active
      };
      this.worker.postMessage('start');
    } catch {
      // Worker creation might fail in restricted iframe environments
    }
  }

  private stopWorkerHeartbeat(): void {
    if (this.worker) {
      try {
        this.worker.postMessage('stop');
        this.worker.terminate();
      } catch {}
      this.worker = null;
    }
  }

  private startSilentAudio(): void {
    if (this.audioCtx) return;
    try {
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) return;

      this.audioCtx = new AudioContextClass();
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume().catch(() => {});
      }

      // Generate a 1-second silent buffer
      const buffer = this.audioCtx.createBuffer(1, this.audioCtx.sampleRate, this.audioCtx.sampleRate);
      const source = this.audioCtx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;

      const gain = this.audioCtx.createGain();
      gain.gain.value = 0.0001; // Silent

      source.connect(gain);
      gain.connect(this.audioCtx.destination);
      source.start();
      this.silentSource = source;
    } catch {
      // AudioContext may be restricted before user gesture
    }
  }

  private stopSilentAudio(): void {
    if (this.silentSource) {
      try {
        this.silentSource.stop();
        this.silentSource.disconnect();
      } catch {}
      this.silentSource = null;
    }
    if (this.audioCtx) {
      try {
        this.audioCtx.close().catch(() => {});
      } catch {}
      this.audioCtx = null;
    }
  }

  /**
   * Notifies user if the tab is hidden when a transfer finishes or cancels.
   */
  public notify(title: string, body: string): void {
    if (
      typeof document !== 'undefined' &&
      document.hidden &&
      typeof Notification !== 'undefined' &&
      Notification.permission === 'granted'
    ) {
      try {
        new Notification(title, {
          body,
          icon: '/favicon.ico',
        });
      } catch {}
    }
  }
}

export const backgroundManager = new BackgroundTransferManager();
