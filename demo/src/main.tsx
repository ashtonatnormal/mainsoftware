import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// The Artifact host supplies its own <html>, so set the page language if it didn't (WCAG 3.1.1).
if (!document.documentElement.lang) document.documentElement.lang = 'en-GB'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
