import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  server: {
    host: true,
    allowedHosts: true,
    proxy: {
      '/api/proxy': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/proxy/, '')
      }
    }
  },
  optimizeDeps: {
    exclude: ['sql.js']
  },
  plugins: [VitePWA({
    registerType: 'autoUpdate',
    includeAssets: ['sql-wasm.js', 'sql-wasm.wasm', 'models/*.onnx', 'icons/*.svg', 'similarities.bin', 'climb_uuids.json'], 
    manifest: {
      name: 'Tension Boardle',
      short_name: 'Boardle',
      description: 'Tension Board 2 Offline PWA',
      theme_color: '#0f172a',
      background_color: '#0f172a',
      display: 'standalone',
      icons: [
        {
          src: 'icons/logo.svg',
          sizes: 'any',
          type: 'image/svg+xml',
          purpose: 'any maskable'
        },
        {
          src: 'icons/logo.svg',
          sizes: '192x192',
          type: 'image/svg+xml'
        },
        {
          src: 'icons/logo.svg',
          sizes: '512x512',
          type: 'image/svg+xml'
        }
      ]
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,ico,png,svg,webp,wasm,onnx,bin,json}'],
      maximumFileSizeToCacheInBytes: 100000000, // 100MB for core
      runtimeCaching: [
        {
          urlPattern: /similarities\.bin(\?.*)?$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'similarity-data',
            expiration: {
              maxEntries: 1,
              maxAgeSeconds: 60 * 60 * 24 * 30, // 30 Days
            },
            cacheableResponse: {
              statuses: [0, 200]
            }
          }
        },
        {
          urlPattern: /climb_uuids\.json(\?.*)?$/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'similarity-map',
            expiration: {
              maxEntries: 1,
              maxAgeSeconds: 60 * 60 * 24 * 30, // 30 Days
            },
            cacheableResponse: {
              statuses: [0, 200]
            }
          }
        },
        {
          urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/npm\/onnxruntime-web/,
          handler: 'CacheFirst',
          options: {
            cacheName: 'onnx-runtime',
            cacheableResponse: {
              statuses: [0, 200]
            }
          }
        }
      ]
    },
    devOptions: {
      enabled: true
    }
  }), cloudflare()]
});