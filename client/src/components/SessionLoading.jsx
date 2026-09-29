import { useAuth } from '../auth/useAuth.js'
import { LoadingBlock } from './ui/Spinner.jsx'

export const WAKING_HINT =
  'The server sleeps when nobody has used it for a while and takes up to a minute to start. ' +
  'You will not have to sign in again.'

/** A stored session being checked, and why it is taking long when it is. */
export function SessionLoading({ label = 'Loading' }) {
  const { waking } = useAuth()
  return <LoadingBlock label={label} hint={waking ? WAKING_HINT : null} />
}
