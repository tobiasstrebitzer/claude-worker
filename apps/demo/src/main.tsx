import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@claude-worker/react/styles.css'
import './demo.css'
import { App } from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
