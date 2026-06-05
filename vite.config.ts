import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: Number(process.env.ATTENTION_WEB_PORT ?? 4321),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.ATTENTION_API_PORT ?? 4332}`,
    },
  },
});
