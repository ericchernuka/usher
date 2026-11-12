import { appVersion } from '@app-version/core/vite'
import { cloudflarePages } from '@app-version/cloudflare'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), appVersion({ skewProtection: cloudflarePages() })],
})
