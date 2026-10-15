import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import { installStubBridge } from '../test-support/stub-bridge'
import {
  JiraImportModal,
  resolveSprintFilter,
  buildJiraFilters,
  mergeJiraRows,
  selectableJiraKeys,
  describeJiraError
} from './JiraImportModal'
import { useStore, initialData } from '../store/store'
import type {
  JiraProjectDTO,
  JiraSprintDTO,
  JiraIssueRowDTO,
  JiraErrorDTO,
  ImportJiraIssuesResultDTO
} from '../../../shared/dto'

const PROJECT_A: JiraProjectDTO = { key: 'PROJ', ticketCount: 5 }
const SPRINT_1: JiraSprintDTO = { id: 1, name: 'Sprint 1', state: 'active' }
const SPRINT_2: JiraSprintDTO = { id: 2, name: 'Sprint 2', state: 'future' }

function row(key: string, over: Partial<JiraIssueRowDTO> = {}): JiraIssueRowDTO {
  return {
    key,
    summary: `Summary for ${key}`,
    status: 'To Do',
    priority: 'Medium',
    type: 'Bug',
    assignee: 'Alice',
    reporter: 'Bob',
    created: '2026-10-01',
    sprintNames: [],
    descriptionMarkdown: 'The description',
    dodMarkdown: '',
    classification: { kind: 'new' },
    ...over
  }
}

/** Installs the stub bridge pre-wired so the modal reaches the ready filter screen. */
function readyBridge(options?: {
  projects?: JiraProjectDTO[]
  sprints?: JiraSprintDTO[]
}): ReturnType<typeof installStubBridge> {
  const bridge = installStubBridge()
  window.octopusAPI.credentials.hasJiraKey = vi.fn().mockResolvedValue(true)
  window.octopusAPI.jira.projects = vi
    .fn()
    .mockResolvedValue({ ok: true, value: options?.projects ?? [PROJECT_A] })
  window.octopusAPI.jira.sprints = vi
    .fn()
    .mockResolvedValue({ ok: true, value: options?.sprints ?? [] })
  return bridge
}

async function waitForReady(): Promise<void> {
  await screen.findByLabelText('Project')
}

beforeEach(() => {
  useStore.setState(initialData())
})

afterEach(() => {
  useStore.setState(initialData())
})

// ── Pure helpers ────────────────────────────────────────────────────────────────

describe('resolveSprintFilter', () => {
  it('resolves None (empty select value) to undefined', () => {
    expect(resolveSprintFilter({ kind: 'select', sprints: [SPRINT_1] }, '', '')).toBeUndefined()
  })

  it('resolves a selected sprint id to its filter, carrying the name', () => {
    expect(resolveSprintFilter({ kind: 'select', sprints: [SPRINT_1] }, '1', '')).toEqual({
      kind: 'id',
      id: 1,
      name: 'Sprint 1'
    })
  })

  it('resolves free text to a name filter when in freetext mode', () => {
    expect(resolveSprintFilter({ kind: 'freetext' }, '', 'Foo')).toEqual({
      kind: 'name',
      text: 'Foo'
    })
  })

  it('trims free text and treats blank as undefined', () => {
    expect(resolveSprintFilter({ kind: 'freetext' }, '', '   ')).toBeUndefined()
  })

  it('still honors free text when the sprint load errored (m2)', () => {
    const error: JiraErrorDTO = { kind: 'gateway', message: 'boom' }
    expect(resolveSprintFilter({ kind: 'error', error }, '', 'Foo')).toEqual({
      kind: 'name',
      text: 'Foo'
    })
  })

  it('resolves to undefined while idle or loading', () => {
    expect(resolveSprintFilter({ kind: 'idle' }, '', 'Foo')).toBeUndefined()
    expect(resolveSprintFilter({ kind: 'loading' }, '', 'Foo')).toBeUndefined()
  })
})

describe('buildJiraFilters', () => {
  it('omits every field left blank', () => {
    expect(
      buildJiraFilters({ project: '', assignee: '', issueKey: '', days: '', sprint: undefined })
    ).toEqual({})
  })

  it('trims project/assignee and normalizes the issue key', () => {
    expect(
      buildJiraFilters({
        project: ' PROJ ',
        assignee: ' bob ',
        issueKey: 'proj-123',
        days: '',
        sprint: undefined
      })
    ).toEqual({ project: 'PROJ', assignee: 'bob', issueKey: 'PROJ-123' })
  })

  it('clamps a fractional-but-positive days value up to 1 (m3)', () => {
    expect(
      buildJiraFilters({ project: '', assignee: '', issueKey: '', days: '0.5', sprint: undefined })
    ).toEqual({ days: 1 })
  })

  it('clamps an out-of-range days value down to 3650 (m3)', () => {
    expect(
      buildJiraFilters({
        project: '',
        assignee: '',
        issueKey: '',
        days: '999999',
        sprint: undefined
      })
    ).toEqual({ days: 3650 })
  })

  it('treats zero or negative days as no filter at all', () => {
    expect(
      buildJiraFilters({ project: '', assignee: '', issueKey: '', days: '0', sprint: undefined })
    ).toEqual({})
    expect(
      buildJiraFilters({ project: '', assignee: '', issueKey: '', days: '-5', sprint: undefined })
    ).toEqual({})
  })

  it('drops a non-numeric days value', () => {
    expect(
      buildJiraFilters({ project: '', assignee: '', issueKey: '', days: 'abc', sprint: undefined })
    ).toEqual({})
  })

  it('includes the sprint filter when present', () => {
    expect(
      buildJiraFilters({
        project: '',
        assignee: '',
        issueKey: '',
        days: '',
        sprint: { kind: 'name', text: 'Sprint 1' }
      })
    ).toEqual({ sprint: { kind: 'name', text: 'Sprint 1' } })
  })
})

describe('mergeJiraRows', () => {
  it('appends incoming rows after existing ones', () => {
    expect(mergeJiraRows([row('A')], [row('B')])).toEqual([row('A'), row('B')])
  })

  it('drops incoming rows already present by key', () => {
    expect(mergeJiraRows([row('A')], [row('A', { summary: 'Changed' }), row('B')])).toEqual([
      row('A'),
      row('B')
    ])
  })
})

describe('selectableJiraKeys', () => {
  it('returns only keys of rows classified as new', () => {
    const rows = [
      row('A'),
      row('B', { classification: { kind: 'duplicate', issueId: 'i1', issueName: 'X' } }),
      row('C', { classification: { kind: 'conflict', issueId: 'i2', issueName: 'Y' } }),
      row('D')
    ]
    expect(selectableJiraKeys(rows)).toEqual(['A', 'D'])
  })
})

describe('describeJiraError', () => {
  it('maps noKey/unauthorized to the Open Settings action', () => {
    expect(describeJiraError({ kind: 'noKey', message: '' })).toEqual({
      message: 'No Jira API key set.',
      action: 'openSettings'
    })
    expect(describeJiraError({ kind: 'unauthorized', message: '' })).toEqual({
      message: 'Jira API key was rejected.',
      action: 'openSettings'
    })
  })

  it('maps unreachable/gateway to Retry', () => {
    expect(describeJiraError({ kind: 'unreachable', message: '' }).action).toBe('retry')
    expect(describeJiraError({ kind: 'gateway', message: 'boom' })).toEqual({
      message: 'boom',
      action: 'retry'
    })
  })

  it('maps invalid to no action, using the message or a fallback', () => {
    expect(describeJiraError({ kind: 'invalid', message: 'bad filter' })).toEqual({
      message: 'bad filter',
      action: 'none'
    })
    expect(describeJiraError({ kind: 'invalid', message: '' })).toEqual({
      message: 'Invalid filters.',
      action: 'none'
    })
  })
})

// ── Credentials / error states ──────────────────────────────────────────────────

describe('<JiraImportModal> credentials', () => {
  it('shows "No Jira API key" with Open Settings when hasJiraKey() is false', async () => {
    installStubBridge()
    window.octopusAPI.credentials.hasJiraKey = vi.fn().mockResolvedValue(false)
    const onClose = vi.fn()
    render(<JiraImportModal onClose={onClose} />)

    await screen.findByText('No Jira API key set.')
    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))

    expect(onClose).toHaveBeenCalled()
    expect(useStore.getState().settingsOpen).toBe(true)
  })

  it('folds an unauthorized project-load error into the single "key rejected" panel (m7)', async () => {
    installStubBridge()
    window.octopusAPI.credentials.hasJiraKey = vi.fn().mockResolvedValue(true)
    window.octopusAPI.jira.projects = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { kind: 'unauthorized', message: 'rejected' } })
    render(<JiraImportModal onClose={vi.fn()} />)

    await screen.findByText('Jira API key was rejected.')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
  })

  it('shows a Retry action on an unreachable project-load error, which reloads projects', async () => {
    installStubBridge()
    window.octopusAPI.credentials.hasJiraKey = vi.fn().mockResolvedValue(true)
    const projects = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'unreachable', message: 'down' } })
      .mockResolvedValueOnce({ ok: true, value: [PROJECT_A] })
    window.octopusAPI.jira.projects = projects
    render(<JiraImportModal onClose={vi.fn()} />)

    await screen.findByText('Jira gateway unreachable.')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    await waitForReady()
    expect(projects).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Jira gateway unreachable.')).not.toBeInTheDocument()
  })
})

// ── Filters ──────────────────────────────────────────────────────────────────────

describe('<JiraImportModal> filters', () => {
  it('prefills every filter field from settings.jira.lastFilters', async () => {
    useStore.setState({
      settings: {
        ...initialData().settings,
        jira: {
          lastFilters: {
            project: 'PROJ',
            assignee: 'bob',
            issueKey: 'PROJ-1',
            days: 30,
            sprint: { kind: 'name', text: 'Sprint text' }
          }
        }
      }
    })
    readyBridge({ sprints: [] })
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    expect(screen.getByLabelText('Project')).toHaveValue('PROJ')
    expect(screen.getByLabelText('Assignee')).toHaveValue('bob')
    expect(screen.getByLabelText('Issue key')).toHaveValue('PROJ-1')
    expect(screen.getByLabelText('Created in last N days')).toHaveValue(30)
    await waitFor(() => expect(screen.getByLabelText('Sprint')).toHaveValue('Sprint text'))
  })

  it('restores a prefilled sprint id once the matching sprint loads', async () => {
    useStore.setState({
      settings: {
        ...initialData().settings,
        jira: { lastFilters: { project: 'PROJ', sprint: { kind: 'id', id: 2, name: 'Sprint 2' } } }
      }
    })
    readyBridge({ sprints: [SPRINT_1, SPRINT_2] })
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    await waitFor(() => expect(screen.getByLabelText('Sprint')).toHaveValue('2'))
  })

  it('shows None first in the sprint dropdown, in the order the sprints were given', async () => {
    readyBridge({ sprints: [SPRINT_1, SPRINT_2] })
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    const select = await screen.findByLabelText('Sprint')
    const options = within(select).getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual([
      'None',
      'Sprint 1 (active)',
      'Sprint 2 (future)'
    ])
  })

  it('falls back to a free-text sprint field when the project has no sprints', async () => {
    readyBridge({ sprints: [] })
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    await waitFor(() => expect(screen.getByLabelText('Sprint').tagName).toBe('INPUT'))
  })

  it('disables Fetch until a Project or Issue key is set', async () => {
    readyBridge()
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled()
  })

  it('an Issue key overrides and dims the other filters, and enables Fetch on its own', async () => {
    readyBridge()
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    fireEvent.change(screen.getByLabelText('Issue key'), { target: { value: 'proj-123' } })

    expect(screen.getByRole('button', { name: 'Fetch' })).toBeEnabled()
    expect(screen.getByLabelText('Project')).toBeDisabled()
    expect(screen.getByLabelText('Assignee')).toBeDisabled()
    expect(screen.getByLabelText('Created in last N days')).toBeDisabled()
    expect(screen.getByText('Issue key overrides the filters above.')).toBeInTheDocument()
  })

  it('shows an inline hint and blocks Fetch for an invalid issue key, without dimming the other filters', async () => {
    readyBridge()
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    fireEvent.change(screen.getByLabelText('Issue key'), { target: { value: 'not-a-key' } })

    expect(screen.getByText('Not a valid issue key (e.g. PROJ-123)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fetch' })).toBeDisabled()
    expect(screen.getByLabelText('Project')).toBeEnabled()
  })
})

// ── Fetch / search ───────────────────────────────────────────────────────────────

describe('<JiraImportModal> fetch', () => {
  it('calls jira.search with the built filters, and persists them', async () => {
    const bridge = readyBridge()
    window.octopusAPI.jira.search = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { rows: [row('A')], total: 1 } })
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))

    await screen.findByTestId('jira-row-A')
    expect(window.octopusAPI.jira.search).toHaveBeenCalledWith({ project: 'PROJ' }, undefined)
    expect(window.octopusAPI.app.updateSettings).toHaveBeenCalledWith({
      jira: { lastFilters: { project: 'PROJ' } }
    })
    expect(useStore.getState().settings.jira?.lastFilters).toEqual({ project: 'PROJ' })
    void bridge
  })

  it('shows a search error with Retry, which replays the same cursor', async () => {
    readyBridge()
    const search = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { kind: 'gateway', message: 'boom' } })
      .mockResolvedValueOnce({ ok: true, value: { rows: [row('A')], total: 1 } })
    window.octopusAPI.jira.search = search
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByText('boom')

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await screen.findByTestId('jira-row-A')
    expect(search).toHaveBeenCalledTimes(2)
    expect(search.mock.calls[1]).toEqual([{ project: 'PROJ' }, undefined])
  })

  it('Load more passes nextCursor and appends de-duplicated rows', async () => {
    readyBridge()
    const search = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        value: { rows: [row('A')], nextCursor: 'c1', total: 2 }
      })
      .mockResolvedValueOnce({
        ok: true,
        value: { rows: [row('A'), row('B')], total: 2 }
      })
    window.octopusAPI.jira.search = search
    render(<JiraImportModal onClose={vi.fn()} />)

    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByTestId('jira-row-A')

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
    await screen.findByTestId('jira-row-B')
    expect(search).toHaveBeenNthCalledWith(2, { project: 'PROJ' }, 'c1')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})

// ── Rows & selection ─────────────────────────────────────────────────────────────

describe('<JiraImportModal> rows', () => {
  async function fetchRows(rows: JiraIssueRowDTO[]): Promise<void> {
    readyBridge()
    window.octopusAPI.jira.search = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { rows, total: rows.length } })
    render(<JiraImportModal onClose={vi.fn()} />)
    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByTestId(`jira-row-${rows[0].key}`)
  }

  it('grays out and disables duplicate/conflict rows with their label', async () => {
    await fetchRows([
      row('A'),
      row('B', { classification: { kind: 'duplicate', issueId: 'i1', issueName: 'Old B' } }),
      row('C', { classification: { kind: 'conflict', issueId: 'i2', issueName: 'Old C' } })
    ])

    expect(screen.getByLabelText('Select A')).toBeEnabled()
    expect(screen.getByLabelText('Select B')).toBeDisabled()
    expect(screen.getByText('Duplicated by Old B')).toBeInTheDocument()
    expect(screen.getByLabelText('Select C')).toBeDisabled()
    expect(screen.getByText('Conflicts with Old C')).toBeInTheDocument()
  })

  it('Select all selects only the New rows, and toggles to Deselect all', async () => {
    await fetchRows([
      row('A'),
      row('B', { classification: { kind: 'duplicate', issueId: 'i1', issueName: 'Old B' } }),
      row('C')
    ])

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }))
    expect(screen.getByLabelText('Select A')).toBeChecked()
    expect(screen.getByLabelText('Select C')).toBeChecked()
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }))
    expect(screen.getByLabelText('Select A')).not.toBeChecked()
    expect(screen.getByText('0 selected')).toBeInTheDocument()
  })

  it('caps Select all at 500 and labels the button accordingly', async () => {
    // Rendering 501 rows in jsdom is close to the default 5s test timeout
    // on its own, and the full suite's parallel workers push it over —
    // give this one test more headroom rather than racing the clock.
    const many = Array.from({ length: 501 }, (_, i) => row(`K${i}`))
    await fetchRows(many)

    expect(screen.getByRole('button', { name: 'Select first 500' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Select first 500' }))
    expect(screen.getByText('500 selected')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled()
  }, 15000)

  it('clicking a row shows its read-only detail pane, replacing the placeholder', async () => {
    await fetchRows([row('A', { sprintNames: ['Sprint 1'] })])

    expect(screen.getByText('Select a row to see details.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Summary for A/ }))

    expect(screen.queryByText('Select a row to see details.')).not.toBeInTheDocument()
    const heading = screen.getByRole('heading', { name: 'A: Summary for A' })
    const detail = within(heading.parentElement as HTMLElement)
    expect(detail.getByText('Alice')).toBeInTheDocument()
    expect(detail.getByText('Bob')).toBeInTheDocument()
    expect(detail.getByText('Sprint 1')).toBeInTheDocument()
    expect(detail.getByText('The description')).toBeInTheDocument()
  })
})

// ── Import ───────────────────────────────────────────────────────────────────────

describe('<JiraImportModal> import', () => {
  function selectRows(keys: string[]): void {
    for (const key of keys) {
      fireEvent.click(screen.getByLabelText(`Select ${key}`))
    }
  }

  it('on a clean import, sends the selected keys and closes the modal', async () => {
    readyBridge()
    window.octopusAPI.jira.search = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { rows: [row('A'), row('B')], total: 2 } })
    const result: ImportJiraIssuesResultDTO = { ok: true, importedCount: 2, skippedKeys: [] }
    window.octopusAPI.jira.import = vi.fn().mockResolvedValue(result)
    const onClose = vi.fn()
    render(<JiraImportModal onClose={onClose} />)
    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByTestId('jira-row-A')
    selectRows(['A', 'B'])

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(window.octopusAPI.jira.import).toHaveBeenCalledWith({ keys: ['A', 'B'] })
  })

  it('on a partial import, stays open, reclassifies imported rows and keeps skipped ones selected', async () => {
    readyBridge()
    window.octopusAPI.jira.search = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { rows: [row('A'), row('B')], total: 2 } })
    const result: ImportJiraIssuesResultDTO = { ok: true, importedCount: 1, skippedKeys: ['B'] }
    window.octopusAPI.jira.import = vi.fn().mockResolvedValue(result)
    const onClose = vi.fn()
    render(<JiraImportModal onClose={onClose} />)
    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByTestId('jira-row-A')
    selectRows(['A', 'B'])

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    await waitFor(() => expect(screen.getByLabelText('Select A')).toBeDisabled())
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByText(/Duplicated by A: Summary for A/)).toBeInTheDocument()
    expect(screen.getByLabelText('Select A')).not.toBeChecked()
    expect(screen.getByLabelText('Select B')).toBeChecked()
    expect(screen.getByText('1 selected')).toBeInTheDocument()
    expect(screen.getByText('Imported 1; skipped 1 (B)')).toBeInTheDocument()
  })

  it('on a failed import, shows the error through JiraErrorNotice and Retry resends the same keys', async () => {
    readyBridge()
    window.octopusAPI.jira.search = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { rows: [row('A')], total: 1 } })
    const jiraImport = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        importedCount: 0,
        skippedKeys: [],
        error: { kind: 'gateway', message: 'disk full' }
      })
      .mockResolvedValueOnce({ ok: true, importedCount: 1, skippedKeys: [] })
    window.octopusAPI.jira.import = jiraImport
    const onClose = vi.fn()
    render(<JiraImportModal onClose={onClose} />)
    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByTestId('jira-row-A')
    fireEvent.click(screen.getByLabelText('Select A'))

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText('disk full')
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(jiraImport).toHaveBeenCalledTimes(2)
    expect(jiraImport).toHaveBeenNthCalledWith(2, { keys: ['A'] })
  })

  it('Open Settings from the import error closes this modal first, then opens Settings', async () => {
    readyBridge()
    window.octopusAPI.jira.search = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { rows: [row('A')], total: 1 } })
    window.octopusAPI.jira.import = vi.fn().mockResolvedValue({
      ok: false,
      importedCount: 0,
      skippedKeys: [],
      error: { kind: 'unauthorized', message: 'rejected' }
    })
    const onClose = vi.fn()
    render(<JiraImportModal onClose={onClose} />)
    await waitForReady()
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'PROJ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Fetch' }))
    await screen.findByTestId('jira-row-A')
    fireEvent.click(screen.getByLabelText('Select A'))
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByRole('button', { name: 'Open Settings' })

    fireEvent.click(screen.getByRole('button', { name: 'Open Settings' }))

    expect(onClose).toHaveBeenCalled()
    expect(useStore.getState().settingsOpen).toBe(true)
  })
})

// ── Overlay contract (.claude/rules/modals-and-overlays.md) ─────────────────────

describe('<JiraImportModal> overlay contract', () => {
  it('renders as a focused, portaled dialog with the required ARIA attributes', async () => {
    readyBridge()
    render(<JiraImportModal onClose={vi.fn()} />)
    await waitForReady()

    const dialog = screen.getByRole('dialog', { name: 'Import from Jira' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAttribute('tabIndex', '-1')
    // Portaled to `document.body`, not nested under some ancestor transform root.
    expect(dialog.parentElement?.parentElement).toBe(document.body)
  })

  it('Escape closes the modal; a backdrop click closes it; a click inside the card does not', async () => {
    readyBridge()
    const onClose = vi.fn()
    render(<JiraImportModal onClose={onClose} />)
    await waitForReady()

    fireEvent.click(screen.getByRole('dialog', { name: 'Import from Jira' }))
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Import from Jira' }), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a backdrop click (outside the card) closes the modal', async () => {
    readyBridge()
    const onClose = vi.fn()
    const { container } = render(<JiraImportModal onClose={onClose} />)
    await waitForReady()
    void container

    fireEvent.click(screen.getByRole('presentation'))
    expect(onClose).toHaveBeenCalled()
  })

  it('stops every key typed in the dialog from reaching the window-level shortcut listener', async () => {
    readyBridge()
    render(<JiraImportModal onClose={vi.fn()} />)
    await waitForReady()
    const spy = vi.fn()
    window.addEventListener('keydown', spy)
    try {
      fireEvent.keyDown(screen.getByLabelText('Assignee'), {
        code: 'KeyW',
        key: 'w',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      fireEvent.keyDown(screen.getByLabelText('Assignee'), {
        code: 'ArrowRight',
        key: 'ArrowRight',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', spy)
    }
  })
})
