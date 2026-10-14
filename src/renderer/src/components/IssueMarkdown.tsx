/**
 * Renders an issue's markdown description (DESIGN "Issues" §13.5) with GitHub-style
 * tables and task lists (`remark-gfm`). Raw HTML is never rendered (`skipHtml`) — on
 * top of that, the app's CSP (`default-src 'self'`) blocks any remote image a stray
 * `<img>` tag could reference anyway, so `img` is rendered as its alt text instead of
 * an element that would just show a broken-image icon.
 *
 * Links never navigate the app window: the default click is suppressed, and only a
 * well-formed `http:`/`https:` URL (`isSafeExternalUrl`, shared with the main-process
 * `shell:openExternal` trust boundary) is handed to the system browser. Anything else
 * (`javascript:`, `file:`, relative, malformed, …) is silently ignored.
 */

import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { isSafeExternalUrl } from '../../../shared/external-url'

export interface IssueMarkdownProps {
  /** The issue's raw markdown `description`. */
  readonly source: string
}

// Hoisted to module scope: `ReactMarkdown` treats a changed
// `remarkPlugins`/`components` identity as "the config changed" and re-parses /
// rebuilds its element tree, so passing fresh array/object literals on every
// render was doing that work on every keystroke of an unrelated parent, for
// content that never actually changes between renders of THIS component.
const REMARK_PLUGINS = [remarkGfm]

const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, title, children, node, ...rest }) => {
    // `node` (the mdast element react-markdown passes when `passNode` is on) is
    // destructured out purely so it's excluded from `...rest` — spreading it
    // onto a real `<a>` would hand React an object as a DOM attribute. It's
    // otherwise unused here.
    void node
    return (
      <a
        {...rest}
        href={href}
        title={title}
        onClick={(e) => {
          e.preventDefault()
          if (href && isSafeExternalUrl(href)) {
            window.octopusAPI.shell.openExternal({ url: href }).catch((err: unknown) => {
              console.error('Failed to open external link', err)
            })
          }
        }}
      >
        {children}
      </a>
    )
  },
  img: ({ alt }) => <>{alt ?? ''}</>
}

export const IssueMarkdown = memo(function IssueMarkdown({
  source
}: IssueMarkdownProps): React.JSX.Element {
  return (
    <div className="issue-markdown">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} skipHtml components={MARKDOWN_COMPONENTS}>
        {source}
      </ReactMarkdown>
    </div>
  )
})
