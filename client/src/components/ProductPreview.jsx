/**
 * A mock of the app for the landing page.
 *
 * Pure CSS and inline SVG — no Konva, no Monaco, no Yjs. Booting the real
 * editor just to decorate a marketing page would pull the heaviest chunks in
 * the bundle into the one route where nobody is editing anything.
 *
 * Marked `aria-hidden`: it is a picture of the product, and the copy beside it
 * already says everything it shows.
 */

const CODE = [
  { n: 1, parts: [['tok-key', 'export function '], ['tok-fn', 'merge'], ['', '(local, remote) {']] },
  { n: 2, parts: [['', '  '], ['tok-com', '// CRDTs converge in any order']] },
  { n: 3, parts: [['', '  '], ['tok-key', 'return '], ['tok-fn', 'Y.applyUpdate'], ['', '(local, remote)']] },
  { n: 4, parts: [['', '}']] },
  { n: 5, parts: [['', '']] },
  { n: 6, parts: [['tok-key', 'const '], ['', 'room = '], ['tok-str', "'sprint-planning'"]] },
]

export function ProductPreview() {
  return (
    <div className="preview" aria-hidden="true">
      <div className="preview__chrome">
        <span className="preview__dots">
          <span />
          <span />
          <span />
        </span>
        <span className="preview__label">syncspace.app/room/sprint-planning</span>
      </div>

      <div className="preview__panes">
        <div className="preview__board">
          <svg
            className="preview__ink"
            viewBox="0 0 420 300"
            fill="none"
            preserveAspectRatio="xMidYMid meet"
          >
            <rect
              x="46"
              y="52"
              width="128"
              height="74"
              rx="8"
              stroke="#f2a03f"
              strokeWidth="2.5"
              style={{ '--len': 420, '--d': 0 }}
            />
            <path
              d="M174 89 L246 89"
              stroke="#22d3ee"
              strokeWidth="2.5"
              strokeLinecap="round"
              style={{ '--len': 80, '--d': 500 }}
            />
            <ellipse
              cx="300"
              cy="89"
              rx="54"
              ry="37"
              stroke="#22d3ee"
              strokeWidth="2.5"
              style={{ '--len': 300, '--d': 700 }}
            />
            <path
              d="M110 126 L110 186 L300 186 L300 130"
              stroke="#a78bfa"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ '--len': 320, '--d': 1100 }}
            />
            <path
              d="M84 224 C120 200, 160 250, 196 224 S268 200, 304 224"
              stroke="#4ade80"
              strokeWidth="2.5"
              strokeLinecap="round"
              style={{ '--len': 300, '--d': 1500 }}
            />
          </svg>

          <span
            className="preview__cursor"
            style={{ left: '58%', top: '62%', background: '#a78bfa' }}
          >
            Priya
          </span>
        </div>

        <div className="preview__code">
          {CODE.map((line) => (
            <div className="preview__line" key={line.n}>
              <span className="preview__gutter">{line.n}</span>
              <span>
                {line.parts.map(([tone, text], index) => (
                  <span key={index} className={tone}>
                    {text}
                  </span>
                ))}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
