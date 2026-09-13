import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { RoomManager } from './roomManager.js';
import type { ClientMessage, ServerMessage } from './types.js';

const currentDir = typeof __dirname !== 'undefined' ? __dirname : process.cwd();

// In dev mode (started with --dev or via npm run dev), default to port 4000 so Vite can use 3000.
// In production (npm start / cloud hosting), default to PORT || 3000 so frontend and server share one port.
const isDevMode = process.argv.includes('--dev') || process.env.npm_lifecycle_event === 'dev';
const defaultPort = isDevMode ? '4000' : '3000';
const PORT = parseInt(process.env.PORT || defaultPort, 10);
const HOST = process.env.HOST || '0.0.0.0';

const roomManager = new RoomManager();

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webp': 'image/webp',
};

// Locate frontend dist directory (root dist or local dist)
const candidateDirs = [
  path.resolve(process.cwd(), 'dist'),
  path.resolve(process.cwd(), 'client/dist'),
  path.resolve(currentDir, '../../dist'),
  path.resolve(currentDir, '../../client/dist'),
  path.resolve(currentDir, '../dist'),
];

const STATIC_DIR = candidateDirs.find(
  (dir) => fs.existsSync(dir) && fs.existsSync(path.join(dir, 'index.html'))
);

// Create HTTP server for frontend assets, health check, and WebSocket upgrade
const server = http.createServer((req, res) => {
  // Simple CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = req.url || '/';
  const pathname = reqUrl.split('?')[0];

  // Health check endpoint
  if (pathname === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    if (req.method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }

    res.writeHead(200);
    res.end(
      JSON.stringify({
        status: 'ok',
        service: 'crossdrop-unified',
        activeRooms: roomManager.activeRoomCount,
        uptime: Math.floor(process.uptime()),
        staticDir: STATIC_DIR ? path.basename(STATIC_DIR) : null,
        timestamp: new Date().toISOString(),
      })
    );
    return;
  }

  // Static file serving & SPA fallback
  if (STATIC_DIR && (req.method === 'GET' || req.method === 'HEAD')) {
    // Sanitize path to prevent directory traversal
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(STATIC_DIR, safePath);

    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }

    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      if (ext === '.html') {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }

      res.writeHead(200, { 'Content-Type': contentType });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(filePath).pipe(res);
      }
      return;
    }

    // SPA fallback: Return index.html for client-side routing
    const indexPath = path.join(STATIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (req.method === 'HEAD') {
        res.end();
      } else {
        fs.createReadStream(indexPath).pipe(res);
      }
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

interface HeartbeatWebSocket extends WebSocket {
  isAlive?: boolean;
}

const wss = new WebSocketServer({ server });

// WebSocket heartbeat to prevent idle connection dropouts across cloud reverse-proxies
const WS_HEARTBEAT_INTERVAL = 30000;
const wsHeartbeatTimer = setInterval(() => {
  wss.clients.forEach((client) => {
    const hbClient = client as HeartbeatWebSocket;
    if (hbClient.isAlive === false) {
      console.log('[WebSocket] Terminating unresponsive socket.');
      return hbClient.terminate();
    }
    hbClient.isAlive = false;
    hbClient.ping();
  });
}, WS_HEARTBEAT_INTERVAL);

wss.on('close', () => {
  clearInterval(wsHeartbeatTimer);
});

function send(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

// Periodic cleanup of inactive rooms every 5 minutes
setInterval(() => {
  const cleaned = roomManager.cleanupInactiveRooms();
  if (cleaned > 0) {
    console.log(`[CleanUp] Cleaned up ${cleaned} inactive room(s).`);
  }
}, 5 * 60 * 1000);

wss.on('connection', (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[WebSocket] New client connected from ${clientIp}`);

  const hbWs = ws as HeartbeatWebSocket;
  hbWs.isAlive = true;
  hbWs.on('pong', () => {
    hbWs.isAlive = true;
  });

  ws.on('message', (raw: Buffer | string) => {
    try {
      // Security guard: Reject messages larger than 64KB (prevent any file data through signaling)
      const dataStr = raw.toString();
      if (dataStr.length > 64 * 1024) {
        send(ws, {
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: 'Payload too large for signaling server.',
        });
        return;
      }

      const msg = JSON.parse(dataStr) as ClientMessage;
      if (!msg || typeof msg !== 'object' || !msg.type) {
        send(ws, {
          type: 'error',
          code: 'INVALID_MESSAGE',
          message: 'Invalid message structure.',
        });
        return;
      }

      switch (msg.type) {
        case 'create-room': {
          const { room } = roomManager.createRoom(ws);
          console.log(`[Room] Created room ${room.id} with code ${room.code}`);
          send(ws, {
            type: 'room-created',
            roomId: room.id,
            code: room.code,
          });
          break;
        }

        case 'join-room': {
          const result = roomManager.joinRoom(msg.code, ws);
          if (!result.success) {
            console.log(`[Room] Join failed for code ${msg.code}: ${result.error}`);
            send(ws, {
              type: 'error',
              code: result.error,
              message: result.message,
            });
            return;
          }

          const { room } = result;
          console.log(`[Room] Client joined room ${room.id} (${room.code})`);

          // Notify joiner that they joined
          send(ws, {
            type: 'room-joined',
            roomId: room.id,
            code: room.code,
            role: 'joiner',
          });

          // Notify the creator that a peer joined
          const creator = room.peers.find((p) => p.role === 'creator');
          if (creator && creator.ws !== ws) {
            send(creator.ws, {
              type: 'peer-joined',
              role: 'peer',
            });
          }
          break;
        }

        case 'signal': {
          const otherPeer = roomManager.getOtherPeer(ws);
          if (!otherPeer) {
            send(ws, {
              type: 'error',
              code: 'ROOM_NOT_FOUND',
              message: 'No other peer in room to receive signaling data.',
            });
            return;
          }

          // Relay signaling data strictly between peers
          send(otherPeer.ws, {
            type: 'signal',
            signalData: msg.signalData,
          });
          break;
        }

        case 'leave-room': {
          const { notifiedPeer } = roomManager.removeSocket(ws);
          if (notifiedPeer) {
            send(notifiedPeer.ws, {
              type: 'peer-disconnected',
              reason: 'Peer left the room.',
            });
          }
          break;
        }

        default: {
          send(ws, {
            type: 'error',
            code: 'INVALID_MESSAGE',
            message: 'Unrecognized message type.',
          });
          break;
        }
      }
    } catch (err: any) {
      console.error('[WebSocket] Error handling message:', err);
      send(ws, {
        type: 'error',
        code: 'INVALID_MESSAGE',
        message: 'Failed to process message.',
      });
    }
  });

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    const { notifiedPeer } = roomManager.removeSocket(ws);
    if (notifiedPeer) {
      send(notifiedPeer.ws, {
        type: 'peer-disconnected',
        reason: 'Peer disconnected.',
      });
    }
  });

  ws.on('error', (err) => {
    console.error('[WebSocket] Socket error:', err);
  });
});

server.on('error', (err: any) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ [Error] Port ${PORT} is already in use by another process.`);
    console.error(`This typically happens because 'npm run dev' is still running in another terminal.`);
    console.error(`\nTo resolve this:`);
    console.error(`  1. Stop 'npm run dev' in your other terminal (press Ctrl+C).`);
    console.error(`  2. Or specify a different port:`);
    console.error(`     PowerShell: $env:PORT="3001"; npm start`);
    console.error(`     Bash/CMD:   PORT=3001 npm start\n`);
    process.exit(1);
  } else {
    console.error('[Server] Fatal server error:', err);
    process.exit(1);
  }
});

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// Keep-Alive Service for Render Free Tier / Cloud Hosting
// Note: Render Free spins down after 15m of no incoming external traffic.
// To keep the service responsive without creating fake users, rooms, or WebRTC sessions,
// a periodic non-blocking HTTP ping is sent to the public service URL.
const KEEP_ALIVE_ENABLED = process.env.KEEP_ALIVE_ENABLED === 'true' || Boolean(process.env.KEEP_ALIVE_URL);
const KEEP_ALIVE_INTERVAL = parseInt(process.env.KEEP_ALIVE_INTERVAL || '60000', 10);
const KEEP_ALIVE_URL =
  process.env.KEEP_ALIVE_URL ||
  (process.env.RENDER_EXTERNAL_URL ? `${process.env.RENDER_EXTERNAL_URL}/health` : null);

let keepAliveTimer: NodeJS.Timeout | null = null;

function initKeepAlive() {
  if (!KEEP_ALIVE_ENABLED) {
    return;
  }

  if (!KEEP_ALIVE_URL) {
    console.log('[KeepAlive] KEEP_ALIVE_ENABLED is true, but no KEEP_ALIVE_URL or RENDER_EXTERNAL_URL was configured.');
    console.log('[KeepAlive] Tip: Set KEEP_ALIVE_URL=https://<your-service>.onrender.com/health in environment variables.');
    return;
  }

  console.log(`[KeepAlive] Service active: pinging ${KEEP_ALIVE_URL} every ${KEEP_ALIVE_INTERVAL / 1000}s`);

  const ping = async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(KEEP_ALIVE_URL, {
        method: 'GET',
        headers: {
          'User-Agent': 'CrossDrop-KeepAlive/1.0',
          'Accept': 'application/json',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        console.warn(`[KeepAlive] Ping to ${KEEP_ALIVE_URL} returned HTTP ${res.status}`);
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        console.warn(`[KeepAlive] Ping failed: ${err.message || err}`);
      }
    }
  };

  // Run initial ping after 5s and then periodically
  setTimeout(ping, 5000);
  keepAliveTimer = setInterval(ping, KEEP_ALIVE_INTERVAL);
  if (keepAliveTimer.unref) {
    keepAliveTimer.unref();
  }
}

server.listen(PORT, HOST, () => {
  const lanIp = getLocalIp();
  console.log(`\n==================================================`);
  console.log(`  CrossDrop Unified Production App Ready`);
  console.log(`  💻 Laptop URL : http://localhost:${PORT}`);
  console.log(`  📱 Phone URL  : http://${lanIp}:${PORT}`);
  console.log(`==================================================\n`);
  if (STATIC_DIR) {
    console.log(`[Server] Serving frontend static assets from: ${STATIC_DIR}`);
  } else {
    console.log('[Server] (Development mode: frontend is served separately by Vite)');
  }

  // Start keep-alive ping engine if configured
  initKeepAlive();
});


