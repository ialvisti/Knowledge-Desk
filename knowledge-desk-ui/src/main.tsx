import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/inter/latin-400.css'
import '@fontsource/inter/latin-500.css'
import '@fontsource/inter/latin-600.css'
import '@fontsource/inter/latin-700.css'
import '@fontsource/newsreader/latin-400.css'
import '@fontsource/newsreader/latin-500.css'
import '@fontsource/newsreader/latin-600.css'
// Variante con ejes de relleno y grosor: las referencias usan iconos rellenos
// (acciones de documentos) y de trazo fino (estados de error).
import '@fontsource-variable/material-symbols-outlined/full.css'
import './index.css'
import './ampliacion.css'
import App from './App'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
