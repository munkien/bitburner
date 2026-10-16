import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const root = process.cwd();

// Vite builds only the React UI. The game scripts (the nexus orchestrator and
// the relay) are plain `.ts` files synced straight from `src/game` by
// `bitburner-filesync` (`npm run sync`) — they are not bundled, because
// Bitburner's own type-stripping compiles them in-game.
export default defineConfig(() => {
    const syncPort = Number(process.env.SYNC_PORT ?? 3000);

    return {
        plugins: [react()],
        server: {
            // Bind IPv4 loopback explicitly. `localhost` resolves to ::1 on this
            // machine, so Vite would otherwise listen on IPv6 only and browsers
            // that try 127.0.0.1 first get a refused connection (which Chromium
            // reports as a confusing "may not load file:///" security error).
            host: "127.0.0.1",
            proxy: {
                // Proxy the sync server's API through the dev server so the
                // browser only ever talks to its own origin (no CORS, no
                // hard-coded server port in the UI). `/api/stream` is SSE, so
                // buffering must stay off for events to arrive promptly.
                "/api": {
                    target: `http://127.0.0.1:${syncPort}`,
                    changeOrigin: true,
                },
            },
        },
        build: {
            outDir: resolve(root, "dist/ui"),
            emptyOutDir: true,
        },
    };
});