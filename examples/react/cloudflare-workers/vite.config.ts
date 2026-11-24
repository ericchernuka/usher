import { usher } from '@ericchernuka/usher-plugin/vite'
import { cloudflareWorkers } from '@ericchernuka/usher-cloudflare'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), usher({ adapter: cloudflareWorkers(), devtools: true })],
})
