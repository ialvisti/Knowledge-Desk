import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // El backend RAG corre en otro puerto. El proxy mantiene las peticiones en el
  // mismo origen, así que el navegador no necesita CORS para consultar.
  const target = env.KNOWLEDGE_API_TARGET || 'http://127.0.0.1:8000'
  // Una síntesis con recuperación tarda unos segundos; el proxy no debe cortar
  // la conexión antes que el cliente.
  const proxy = {
    '/api': { target, changeOrigin: false, timeout: 180_000, proxyTimeout: 180_000 },
  }
  return {
    plugins: [react(), tailwindcss()],
    server: { proxy },
    preview: { proxy },
  }
})
