import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'print-lan-url',
      configureServer(server) {
        server.httpServer?.once('listening', () => {
          setTimeout(() => {
            const address = server.httpServer?.address();
            const port = typeof address === 'object' && address?.port ? address.port : 3000;
            const interfaces = os.networkInterfaces();
            const ips: string[] = [];
            for (const iface of Object.values(interfaces)) {
              if (!iface) continue;
              for (const alias of iface) {
                if (alias.family === 'IPv4' && !alias.internal) {
                  ips.push(alias.address);
                }
              }
            }
            console.log('\n==================================================');
            console.log('  CrossDrop LAN Dev Server Ready');
            if (ips.length > 0) {
              ips.forEach((ip) => {
                console.log(`  📱 Phone URL : http://${ip}:${port}`);
              });
            } else {
              console.log(`  📱 Phone URL : http://<your-local-ip>:${port}`);
            }
            console.log(`  💻 Local URL : http://localhost:${port}`);
            console.log('==================================================\n');
          }, 200);
        });
      },
    },
  ],
  server: {
    host: '0.0.0.0', // Expose to local network (LAN) for testing between phone and PC
    port: 3000,
    strictPort: false,
    cors: true,
    hmr: {
      overlay: true,
    },
    proxy: {
      '/ws': {
        target: 'ws://localhost:4000',
        ws: true,
        rewriteWsOrigin: true,
      },
      '/health': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  optimizeDeps: {
    include: ['react', 'react-dom'],
  },
  build: {
    target: 'esnext',
  },
});
