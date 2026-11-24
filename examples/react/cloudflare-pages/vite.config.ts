import { usher } from '@ericchernuka/usher-plugin/vite'
import { cloudflarePages } from '@ericchernuka/usher-cloudflare'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), usher({ adapter: cloudflarePages(), devtools: true })],
})
