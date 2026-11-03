import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  base: "/surface-measurement/",
  plugins: [react()],
  server: { port: 5173, fs: { allow: [".."] } },
  build: {
    outDir: "dist",
    sourcemap: false,
    target: "es2022",
    rollupOptions: { input: { main: "index.html", bench: "bench.html" } },
  },
  esbuild: { target: "es2022" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
