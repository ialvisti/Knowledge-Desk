import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // La interfaz solo habla con el servidor de Knowledge Desk, que guarda las
  // credenciales de ForUsGuide, Pinecone o del proveedor. En desarrollo el proxy
  // mantiene las peticiones en el mismo origen; en producción el propio servidor
  // sirve la interfaz compilada. Ninguna variable VITE_* existe a propósito.
  const target = env.KD_SERVER_URL || 'http://127.0.0.1:8787'
  const proxy = {
    '/api': { target, changeOrigin: false, timeout: 180_000, proxyTimeout: 180_000 },
  }
  return {
    plugins: [react(), tailwindcss()],
    server: { proxy },
    preview: { proxy },
  }
})
