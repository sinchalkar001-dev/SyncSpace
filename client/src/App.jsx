import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './components/ProtectedRoute.jsx'
import { LoadingBlock } from './components/ui/Spinner.jsx'
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import Dashboard from './pages/Dashboard.jsx'
import NotFound from './pages/NotFound.jsx'

/**
 * The room is the only route that needs Monaco and Konva, and together they
 * dominate the bundle. Vite already splits them into their own chunks, but a
 * static import would still pull them into the initial load for someone who
 * only ever visits the landing page. Loading the route on demand keeps them
 * off the critical path until a room is actually opened.
 */
const Room = lazy(() => import('./pages/Room.jsx'))

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route
        path="/dashboard"
        element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        }
      />
      <Route
        path="/room/:roomId"
        element={
          <Suspense fallback={<LoadingBlock label="Opening room" />}>
            <Room />
          </Suspense>
        }
      />
      <Route path="*" element={<NotFound />} />
    </Routes>
  )
}
