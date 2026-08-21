import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { LoadingBlock } from './ui/Spinner.jsx'

/** Gate for screens that need a real account, such as the dashboard. */
export function ProtectedRoute({ children }) {
  const { isLoading, isAuthenticated } = useAuth()
  const location = useLocation()

  if (isLoading) return <LoadingBlock label="Restoring your session" />

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return children
}
