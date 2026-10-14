import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent, within } from '@testing-library/react'
import { IssueList, descriptionPreview } from './IssueList'
import { useStore, initialData } from '../store/store'
import { installStubBridge } from '../test-support/stub-bridge'
import type {
  IssueDTO,
  IssueStatusDTO,
  TaskDTO,
  WindowedWorkspaceStateDTO
} from '../../../shared/dto'

function issue(id: string, over: Partial<IssueDTO> = {}): IssueDTO {
  return {
    id,
    name: id,
    description: '',
    status: 'todo',
    createdAt: 1000,
    updatedAt: 1000,
    ...over
  }
}

function seed(issues: IssueDTO[], tasks: TaskDTO[] = []): void {
  const state: WindowedWorkspaceStateDTO = {
    tasks,
    activeTaskId: undefined,
    sessionTypes: [],
    issues,
    settings: {
      worktree: { location: '' },
      terminal: {},
      defaultSessionTypeId: 'terminal',
      groupTasksByRepo: true
    },
    version: 1,
    thisWindowId: 'main',
    thisWindowRole: 'main',
    windows: []
  }
  useStore.getState().hydrate(state)
}

/** Each group header is a `<button>` whose text starts with an arrow glyph, a space,
 * then the status label (e.g. "▾ Todo"), followed by a sibling count `<span>`. Status
 * icons on the ROWS are ARIA-labelled with the status word too (e.g. "Todo"), which
 * would also match a plain accessible-name lookup for a status label — so headers are
 * found by their own text node via `getByText`, not by accessible name. */
function groupHeader(label: string): HTMLElement {
  // The header span's text is the collapse glyph + a space + the label (e.g.
  // "▾ Todo"), so an exact-text lookup for the bare label never matches — anchor on
  // the glyph prefix instead of loosening to a substring match (which could collide
  // with a row's issue-name text containing the same word).
  const el = screen.getByText(new RegExp(`^[▾▸] ${label}$`)).closest('button')
  if (!el) throw new Error(`group header for "${label}" not found`)
  return el
}

function issueRow(name: string): HTMLElement {
  const el = screen.getByText(name, { selector: 'span' }).closest('button')
  if (!el) throw new Error(`issue row for "${name}" not found`)
  return el
}

describe('<IssueList>', () => {
  beforeEach(() => {
    useStore.setState(initialData())
    installStubBridge()
  })

  it('groups issues by status in the fixed order, each with a count', () => {
    seed([
      issue('t1', { status: 'todo' }),
      issue('t2', { status: 'todo' }),
      issue('p1', { status: 'in_progress' }),
      issue('r1', { status: 'in_review' }),
      issue('r2', { status: 'in_review' }),
      issue('r3', { status: 'in_review' }),
      issue('d1', { status: 'done' })
    ])
    render(<IssueList />)
    const todo = groupHeader('Todo')
    const inProgress = groupHeader('In progress')
    const inReview = groupHeader('In review')
    const done = groupHeader('Done')
    // Document order follows the fixed status order. Group headers are the only
    // buttons carrying `aria-expanded` (rows carry `aria-pressed` instead) — an
    // ARIA-attribute filter rather than a className one.
    const all = screen.getAllByRole('button').filter((b) => b.hasAttribute('aria-expanded'))
    expect(all).toEqual([todo, inProgress, inReview, done])
    expect(todo.textContent).toContain('2')
    expect(inProgress.textContent).toContain('1')
    expect(inReview.textContent).toContain('3')
    expect(done.textContent).toContain('1')
  })

  it('shows issues newest first within a group', () => {
    seed([
      issue('old', { status: 'todo', createdAt: 1000, name: 'Old one' }),
      issue('new', { status: 'todo', createdAt: 2000, name: 'New one' })
    ])
    render(<IssueList />)
    // Each row's textContent is "<status glyph><name>" with no separating space
    // (the icon and the name are adjacent JSX elements, not a joined text run), so
    // match on substring rather than the exact glyph+name string. Rows are the only
    // buttons carrying `aria-pressed` (group headers carry `aria-expanded` instead).
    const rows = screen
      .getAllByRole('button')
      .filter((b) => b.hasAttribute('aria-pressed'))
      .map((b) => b.textContent)
    expect(rows).toEqual([expect.stringContaining('New one'), expect.stringContaining('Old one')])
  })

  it('starts with the Done group collapsed, and toggles open/closed on click', () => {
    seed([issue('d1', { status: 'done', name: 'Finished thing' })])
    render(<IssueList />)
    const doneHeader = groupHeader('Done')
    expect(doneHeader).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Finished thing')).not.toBeInTheDocument()

    fireEvent.click(doneHeader)
    expect(doneHeader).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Finished thing')).toBeInTheDocument()

    fireEvent.click(doneHeader)
    expect(doneHeader).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Finished thing')).not.toBeInTheDocument()
  })

  it('other groups start expanded', () => {
    seed([issue('t1', { status: 'todo', name: 'A task' })])
    render(<IssueList />)
    expect(groupHeader('Todo')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('A task')).toBeInTheDocument()
  })

  it('clicking a row selects the issue in the store', () => {
    seed([issue('t1', { name: 'Pick me' })])
    render(<IssueList />)
    fireEvent.click(issueRow('Pick me'))
    expect(useStore.getState().selectedIssueId).toBe('t1')
  })

  it('clicking "+ New Issue" starts a draft in the store', () => {
    seed([])
    render(<IssueList />)
    fireEvent.click(screen.getByRole('button', { name: '+ New Issue' }))
    expect(useStore.getState().issueDraft).toBe(true)
  })

  it('each row shows the status icon and the issue name', () => {
    const statuses: IssueStatusDTO[] = ['todo', 'in_progress', 'in_review', 'done']
    seed(statuses.map((status, i) => issue(`i${i}`, { status, name: `Issue ${i}` })))
    render(<IssueList />)
    // Expand Done to see its row too.
    fireEvent.click(groupHeader('Done'))
    for (let i = 0; i < statuses.length; i++) {
      const row = issueRow(`Issue ${i}`)
      expect(within(row).getByRole('img')).toBeInTheDocument()
      expect(row).toHaveTextContent(`Issue ${i}`)
    }
  })

  it('a row shows a one-line description preview, the project chip and the linked task', () => {
    seed(
      [
        issue('i1', {
          name: 'Rich',
          description: '\n## Fix the **login** flow\nmore text',
          projectPath: '/src/app',
          taskId: 't1'
        }),
        issue('i2', { name: 'Bare' })
      ],
      [
        {
          id: 't1',
          name: 'Login task',
          lifecycle: 'ready',
          state: 'unknown',
          sessions: [],
          position: 0,
          createdAt: 1000,
          groups: []
        }
      ]
    )
    render(<IssueList />)

    const rich = issueRow('Rich')
    expect(within(rich).getByText('Fix the login flow')).toBeInTheDocument()
    expect(within(rich).getByText('app')).toHaveAttribute('title', '/src/app')
    expect(within(rich).getByTitle('Linked task: Login task')).toHaveTextContent('Login task')

    // No description, project or task: just the icon and the name.
    const bare = issueRow('Bare')
    expect(bare.textContent).toBe('Bare')
    expect(within(bare).queryByTitle(/^Linked task/)).not.toBeInTheDocument()
  })

  it('the "+ New Issue" button is a compact header button, not a full-width bar', () => {
    seed([])
    render(<IssueList />)
    expect(screen.getByRole('button', { name: '+ New Issue' }).style.width).toBe('')
  })
})

describe('descriptionPreview', () => {
  it.each([
    ['', ''],
    ['\n\n  \n', ''],
    ['plain first line\nsecond', 'plain first line'],
    ['# Heading', 'Heading'],
    ['> quoted *text*', 'quoted text'],
    ['- [ ] a task box', 'a task box'],
    ['1. numbered', 'numbered'],
    ['see [the docs](https://x.y) and `code`', 'see the docs and code'],
    ['![alt](img.png) after', 'alt after']
  ])('%j → %j', (input, expected) => {
    expect(descriptionPreview(input)).toBe(expected)
  })
})
