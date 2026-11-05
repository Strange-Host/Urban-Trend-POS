import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/schibsted-grotesk/latin-400.css'
import '@fontsource/schibsted-grotesk/latin-500.css'
import '@fontsource/schibsted-grotesk/latin-600.css'
import '@fontsource/schibsted-grotesk/latin-700.css'
import './index.css'
import App from './App.jsx'
import { applyUiFlagFromUrl } from './utils/uiVersion'

// Read ?ut_ui=v1|v2 before anything renders, so the first paint already uses the right shell.
applyUiFlagFromUrl()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
