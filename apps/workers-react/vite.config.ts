import { appVersion } from '@app-version/core/vite'
import { cloudflareWorkers } from '@app-version/cloudflare'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), appVersion({ skewProtection: cloudflareWorkers() })],
})
