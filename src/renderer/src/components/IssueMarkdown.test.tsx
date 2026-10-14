import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { IssueMarkdown } from './IssueMarkdown'
import { installStubBridge } from '../test-support/stub-bridge'

describe('<IssueMarkdown> (Issues §13.5)', () => {
  beforeEach(() => {
    installStubBridge()
  })

  it('renders a GFM table as real table elements', () => {
    const { container } = render(<IssueMarkdown source={'| a | b |\n|---|---|\n| 1 | 2 |'} />)
    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(container.querySelectorAll('tr')).toHaveLength(2)
    const td = container.querySelector('td')
    expect(td).not.toBeNull()
    expect(td?.textContent).toBe('1')
  })

  it('renders a GFM task list as checkboxes reflecting checked state', () => {
    render(<IssueMarkdown source={'- [ ] foo\n- [x] bar'} />)
    const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[]
    expect(checkboxes).toHaveLength(2)
    expect(checkboxes[0].checked).toBe(false)
    expect(checkboxes[1].checked).toBe(true)
  })

  it('does not render raw embedded HTML (skipHtml)', () => {
    const { container } = render(
      <IssueMarkdown source={'<script>window.x=1</script>\n\n<div class="injected">hi</div>'} />
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('.injected')).toBeNull()
    expect(container.textContent).not.toContain('window.x=1')
    expect(container.textContent).not.toContain('hi')
  })

  it('opens a safe https link via window.octopusAPI.shell.openExternal and does not navigate', async () => {
    const originalHref = window.location.href
    render(<IssueMarkdown source={'[text](https://example.com)'} />)
    const link = screen.getByRole('link', { name: 'text' })
    expect(fireEvent.click(link)).toBe(false) // preventDefault ran
    expect(window.octopusAPI.shell.openExternal).toHaveBeenCalledWith({
      url: 'https://example.com'
    })
    // Note: jsdom never actually navigates on an anchor click in the first place
    // (there's no real browsing context), so the `href` assertion below would pass
    // even without the component's own `e.preventDefault()` — it does not, by
    // itself, prove the click was suppressed. The `fireEvent.click(...)` return
    // value above (false => a cancelable default was prevented) is what actually
    // exercises that behavior.
    expect(window.location.href).toBe(originalHref)
  })

  it('does not open a javascript: link', () => {
    const { container } = render(<IssueMarkdown source={'[text](javascript:alert(1))'} />)
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(fireEvent.click(link as HTMLAnchorElement)).toBe(false) // preventDefault ran
    expect(window.octopusAPI.shell.openExternal).not.toHaveBeenCalled()
  })

  it('does not open a file: link', () => {
    const { container } = render(<IssueMarkdown source={'[text](file:///etc/passwd)'} />)
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(fireEvent.click(link as HTMLAnchorElement)).toBe(false) // preventDefault ran
    expect(window.octopusAPI.shell.openExternal).not.toHaveBeenCalled()
  })

  it.each(['mailto:test@example.com', 'xmpp:user@example.com', 'irc://example.com/chan'])(
    'does not open a %s link',
    (href) => {
      const { container } = render(<IssueMarkdown source={`[text](${href})`} />)
      const link = container.querySelector('a')
      expect(link).not.toBeNull()
      expect(fireEvent.click(link as HTMLAnchorElement)).toBe(false) // preventDefault ran
      expect(window.octopusAPI.shell.openExternal).not.toHaveBeenCalled()
    }
  )

  it('does not open a relative link', () => {
    const { container } = render(<IssueMarkdown source={'[text](./relative/path)'} />)
    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(fireEvent.click(link as HTMLAnchorElement)).toBe(false) // preventDefault ran
    expect(window.octopusAPI.shell.openExternal).not.toHaveBeenCalled()
  })

  it('renders an image as its alt text, not an <img> element (CSP blocks remote images)', () => {
    const { container } = render(
      <IssueMarkdown source={'![a picture](https://example.com/x.png)'} />
    )
    expect(container.querySelector('img')).toBeNull()
    expect(screen.getByText('a picture')).toBeInTheDocument()
  })
})
