import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // Listen on the LAN interface, not just localhost, so a phone on the
    // same WiFi can reach this dev server at http://<your-computer-ip>:5173.
    host: true,
  },
})
