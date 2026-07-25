import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // The build this bundle came from, stamped in by the Docker build. `dev`
  // locally, which switches the version UI off rather than showing noise.
  define: {
    __APP_VERSION__: JSON.stringify(process.env['APP_VERSION']?.trim() || 'dev'),
  },
  plugins: [
    react(),
    VitePWA({
      /*
       * `prompt`, not `autoUpdate`.
       *
       * A reader that reloads itself out from under you mid-hint is worse than
       * one that waits: the new service worker now sits in `waiting` until the
       * user asks for it, which is what makes an "update available" indicator
       * meaningful rather than a race with an automatic refresh.
       */
      registerType: 'prompt',
      injectRegister: null,
      // The whole shell is precached: the app must cold-launch in airplane mode.
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        // API responses are never cached by the service worker — downloaded
        // content lives in IndexedDB, and a stale catalogue would be a lie.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\//,
            handler: 'NetworkOnly',
          },
        ],
        cleanupOutdatedCaches: true,
      },
      includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
      manifest: {
        name: 'Omni UHS',
        short_name: 'Hints',
        description: 'Personal, spoiler-safe, offline game hint reader',
        theme_color: '#12141c',
        background_color: '#12141c',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env['PROXY_TARGET'] ?? 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
