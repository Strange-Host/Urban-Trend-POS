import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/schibsted-grotesk/latin-400.css'
import '@fontsource/schibsted-grotesk/latin-500.css'
import '@fontsource/schibsted-grotesk/latin-600.css'
import '@fontsource/schibsted-grotesk/latin-700.css'
import './index.css'
import App from './App.jsx'
import { clearRetiredPreferences } from './utils/legacyStorage'

// The old sidebar and the layout flag are gone; forget what they saved in this browser.
clearRetiredPreferences()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
