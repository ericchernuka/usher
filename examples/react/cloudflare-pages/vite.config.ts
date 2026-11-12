import { usher } from '@rndsqr/usher-plugin/vite'
import { cloudflarePages } from '@rndsqr/usher-cloudflare'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), usher({ adapter: cloudflarePages() })],
})
