import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './styles/global.css'
import App from './App.jsx'
import { AuthProvider } from './auth/AuthProvider.jsx'
import { ToastProvider } from './components/ui/ToastProvider.jsx'
import { ErrorBoundary } from './components/ErrorBoundary.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <AuthProvider>
            {/* First stop for keyboard users, before the nav on every page. */}
            <a className="skip-link" href="#main">
              Skip to content
            </a>
            <App />
          </AuthProvider>
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
)
