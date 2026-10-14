import { defineConfig } from "vite";

// Dev server proxies the API to a local `geocow serve` so the frontend
// and backend share an origin (no CORS needed). In production the same
// server serves both the built assets and /api.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
