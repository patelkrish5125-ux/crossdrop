/**
 * CrossDrop Client Configuration
 * Single source of truth for the signaling server endpoint.
 */

export interface SignalingConfig {
  url: string;
  isConfigured: boolean;
  source: 'env' | 'same-origin' | 'fallback';
}

export function getSignalingConfig(): SignalingConfig {
  const envUrl = import.meta.env.VITE_SIGNALING_URL;

  // 1. Explicit environment variable override (if provided)
  if (envUrl && typeof envUrl === 'string' && envUrl.trim().length > 0) {
    let url = envUrl.trim();
    if (typeof window !== 'undefined' && window.location.protocol === 'https:' && url.startsWith('ws://')) {
      url = url.replace(/^ws:\/\//i, 'wss://');
    }
    return {
      url,
      isConfigured: true,
      source: 'env',
    };
  }

  // 2. Same-origin WebSocket (Unified production server & Vite dev proxy)
  if (typeof window !== 'undefined' && window.location && window.location.host) {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const sameOriginUrl = `${wsProtocol}//${window.location.host}/ws`;

    return {
      url: sameOriginUrl,
      isConfigured: true,
      source: 'same-origin',
    };
  }

  // Fallback for tests/SSR
  return {
    url: 'ws://localhost:3000/ws',
    isConfigured: true,
    source: 'fallback',
  };
}

export function getSignalingUrl(): string {
  return getSignalingConfig().url;
}
