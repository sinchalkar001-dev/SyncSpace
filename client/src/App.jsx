import { lazy, Suspense } from 'react'
import { Route, Routes } from 'react-router-dom'
import { ProtectedRoute } from './components/ProtectedRoute.jsx'
import { LoadingBlock } from './components/ui/Spinner.jsx'
import Home from './pages/Home.jsx'
import Login from './pages/Login.jsx'
import Register from './pages/Register.jsx'
import Privacy from './pages/Privacy.jsx'
import NotFound from './pages/NotFound.jsx'

/**
 * Only the pages a first visit can land on are in the entry bundle.
 *
 * The room is the only route that needs Monaco and Konva, and together they
 * dominate the bundle; a static import would pull them into the initial load
 * for someone who only ever visits the landing page. The dashboard is behind a
 * sign-in, and the rest are reached from a link in an email — none of them is
 * worth making every visitor to the landing page download first.
 */
const Room = lazy(() => import('./pages/Room.jsx'))
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'))
const VerifyEmail = lazy(() => import('./pages/VerifyEmail.jsx'))
const AcceptInvitation = lazy(() => import('./pages/AcceptInvitation.jsx'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword.jsx'))
const ResetPassword = lazy(() => import('./pages/ResetPassword.jsx'))

export default function App() {
  return (
    <Suspense fallback={<LoadingBlock label="Loading" />}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        {/* Reachable without an account, and linked from the foot of every
            page a stranger can land on. */}
        <Route path="/privacy" element={<Privacy />} />
        {/* Where every confirmation email points. Open to signed-out visitors:
            the link is as likely to be opened on a phone that has never signed
            in as in the browser that registered. */}
        <Route path="/verify-email" element={<VerifyEmail />} />
        {/* The same screen: one is where the email sends you, the other is
            where signing up sends you, and both need the code entry. */}
        <Route path="/check-email" element={<VerifyEmail />} />
        <Route path="/accept-invitation" element={<AcceptInvitation />} />
        {/* Recovery, and necessarily open to signed-out visitors: being unable
            to sign in is the entire reason for coming here. */}
        <Route path="/forgot-password" element={<ForgotPassword />} />
        <Route path="/reset-password" element={<ResetPassword />} />
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
    </Suspense>
  )
}
