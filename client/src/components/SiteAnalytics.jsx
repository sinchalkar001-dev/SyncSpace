import { Analytics } from '@vercel/analytics/react'
import { redactPageView } from '../lib/analytics.js'

/**
 * Page counts from Vercel Web Analytics, which sets no cookies and keeps no
 * identifier past the day.
 *
 * Production deployments only: VITE_VERCEL_ENV is set by Vercel's build and by
 * nothing else, so a preview, a local build or another host counts nothing.
 */
export function SiteAnalytics() {
  if (import.meta.env.VITE_VERCEL_ENV !== 'production') return null
  return <Analytics beforeSend={redactPageView} />
}
