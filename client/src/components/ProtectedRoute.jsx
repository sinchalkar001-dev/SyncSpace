import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/useAuth.js'
import { Spinner } from './ui/Spinner.jsx'

/** Gate for screens that need a real account, such as the dashboard. */
export function ProtectedRoute({ children }) {
  const { isLoading, isAuthenticated } = useAuth()
  const location = useLocation()

  if (isLoading) {
    return (
      <div className="route-loading">
        <Spinner label="Restoring your session" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />
  }

  return children
}
