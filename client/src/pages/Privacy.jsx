import { Link } from 'react-router-dom'
import { TopBar, Brand } from '../components/TopBar.jsx'
import { SiteFooter } from '../components/SiteFooter.jsx'
import { usePageMeta } from '../hooks/usePageMeta.js'

/**
 * What this deployment stores, in the words somebody reading it would use.
 *
 * Written from what the code actually does rather than from a template: every
 * line below names something the server really keeps. A policy that promises
 * more than the code does is worse than no policy, so where a thing is not
 * built — deleting an account, for one — it says so.
 */
export default function Privacy() {
  usePageMeta({
    title: 'Privacy',
    description: 'What SyncSpace stores, why it stores it, and how long it keeps it.',
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
        <h1>Privacy</h1>
        <p className="prose__lede">
          SyncSpace is a collaborative whiteboard and code editor. This page says what it stores,
          why, and for how long.
        </p>

        <h2>What is stored</h2>
        <ul>
          <li>
            <strong>Your account.</strong> Name, email address and a hashed password. Passwords are
            hashed with bcrypt and cannot be read back.
          </li>
          <li>
            <strong>Your rooms.</strong> The whiteboard, the code buffer, files you upload, chat
            about a room, comments, and the edit history that makes replay work.
          </li>
          <li>
            <strong>What ran.</strong> When code is run, the program and its output are kept so the
            console survives a reload.
          </li>
          <li>
            <strong>Signed-in devices.</strong> One record per session, with the browser and address
            it was opened from, so you can sign a device out from the account menu.
          </li>
          <li>
            <strong>Activity.</strong> That somebody joined, ran code or commented — never what was
            said in chat.
          </li>
        </ul>

        <h2>Who else sees it</h2>
        <ul>
          <li>
            <strong>People in your rooms.</strong> A private room is limited to its owner and the
            people invited; a public room is open to anyone with the link.
          </li>
          <li>
            <strong>The AI provider.</strong> Using the copilot or a session summary sends the part
            of the room the action names — the diagram, the code, the run output — to the model
            provider configured for this deployment. Nothing is sent until you press one of those
            buttons, and the panel shows what was read before it answers.
          </li>
          <li>
            <strong>The email relay.</strong> Your address is given to the mail provider to send
            verification, password reset and invitation messages.
          </li>
        </ul>
        <p>Nothing is sold, and there is no advertising or third-party analytics.</p>

        <h2>How long it is kept</h2>
        <ul>
          <li>Run records expire on their own after a retention period set by this deployment.</li>
          <li>Activity entries expire the same way.</li>
          <li>
            Deleting a room deletes what belonged to it: its history, files, comments, runs and
            copilot answers.
          </li>
          <li>Everything else is kept until it is deleted.</li>
        </ul>

        <h2>In your browser</h2>
        <p>
          Your sign-in token and a few preferences — pane layout, editor options, whether you share
          your activity — are kept in your browser&apos;s local storage. There are no tracking
          cookies.
        </p>

        <h2>What you control</h2>
        <ul>
          <li>Delete a room, and its contents go with it.</li>
          <li>Remove a file you uploaded.</li>
          <li>Turn off sharing your activity from the people menu in a room.</li>
          <li>Sign out one device, or all of them, from the account menu.</li>
          <li>
            Deleting a whole account is not built yet. Ask whoever runs this deployment to remove
            it.
          </li>
        </ul>

        <h2>Asking about your data</h2>
        <p>
          SyncSpace is an open-source project, and this is one deployment of it. Whoever runs this
          deployment is responsible for the data in it — contact them, or open an issue on the
          project&apos;s repository.
        </p>
      </main>

      <SiteFooter />
    </div>
  )
}
