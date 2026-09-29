import { Link } from 'react-router-dom'
import { TopBar, Brand } from '../components/TopBar.jsx'
import { SiteFooter } from '../components/SiteFooter.jsx'
import { usePageMeta } from '../hooks/usePageMeta.js'

/**
 * The rules for using a deployment, written like the privacy notice: from
 * what the product does, and short enough to be read.
 */
export default function Terms() {
  usePageMeta({
    title: 'Terms of use',
    description:
      'The rules for using SyncSpace: your content, public rooms, running code, and what is not promised.',
  })

  return (
    <div className="landing">
      <TopBar>
        <Brand />
        <div className="topbar__right">
          <Link className="btn btn--ghost" to="/login">
            Sign in
          </Link>
        </div>
      </TopBar>

      <main className="prose" id="main">
        <h1>Terms of use</h1>
        <p className="prose__lede">
          The rules for using this deployment of SyncSpace. Last updated 30 September 2026.
        </p>

        <h2>Your content</h2>
        <p>
          What you put in a room — drawings, code, files, chat and comments — stays yours. You let
          this deployment store it and show it to the people in the room, and only so that the
          product works. Upload only what you have the right to share.
        </p>

        <h2>Public rooms</h2>
        <p>
          Anyone with the link to a public room can read it and change it. Keep anything you would
          not show a stranger in a private room, where only the people you invite can get in.
        </p>

        <h2>Running code</h2>
        <p>
          Programs run in a sandbox with limits on time, memory and output. Do not use it to mine
          cryptocurrency, to reach or attack other systems, to try to get out of the sandbox or
          around its limits, or to run anything unlawful. A run that does may be stopped and the
          account behind it removed.
        </p>

        <h2>Using it fairly</h2>
        <ul>
          <li>No unlawful content, harassment, spam or malware.</li>
          <li>No attempts to get into rooms or accounts that are not yours.</li>
          <li>No automated sign-ups, and no traffic meant to slow the service down for others.</li>
        </ul>

        <h2>Your account</h2>
        <p>
          Keep your password to yourself; what happens under your account is your responsibility. An
          account that breaks these terms may be suspended or removed.
        </p>

        <h2>The copilot</h2>
        <p>
          Its answers come from an AI model and can be wrong. Check them before you rely on them.
          What it is sent is described in the <Link to="/privacy">privacy notice</Link>.
        </p>

        <h2>What is not promised</h2>
        <p>
          SyncSpace runs on free hosting. It can be slow to start, go down, change, or be reset
          without notice, so keep your own copy of anything you cannot afford to lose. It is
          provided as it is, without any warranty, and as far as the law allows, whoever runs this
          deployment is not liable for data that is lost or for any other harm from using it.
        </p>

        <h2>Changes</h2>
        <p>
          These terms may change, and the date at the top says when they last did. Using SyncSpace
          after a change means accepting the new terms.
        </p>

        <h2>Questions</h2>
        <p>
          SyncSpace is an open-source project, and this is one deployment of it. Ask whoever runs
          this deployment, or open an issue on the project&apos;s repository.
        </p>
      </main>

      <SiteFooter />
    </div>
  )
}
