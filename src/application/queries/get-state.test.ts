import { describe, it, expect } from 'vitest'
import { getState } from './get-state'
import { createTask } from '../use-cases/create-task'
import { createIssue } from '../use-cases/create-issue'
import { makeDeps, taskInput } from '../use-cases/test-fakes'
import { TaskState } from '../../domain/state'

describe('getState read-model (§5.2)', () => {
  it('assembles the workspace snapshot, available session types, settings, and version', async () => {
    const fd = makeDeps()
    await createTask(fd.deps, taskInput('T'))

    const view = getState(fd.deps)

    // Workspace snapshot mirrors the live aggregate.
    expect(view.workspace.tasks).toHaveLength(1)
    expect(view.workspace.tasks[0].name).toBe('T')
    expect(view.workspace.activeTaskId).toBe(fd.workspace.activeTaskId)

    // V1: state is always Unknown (aggregator all→Unknown; no icons rendered).
    expect(view.workspace.tasks[0].state).toBe(TaskState.Unknown)

    // Session types available at V1: just terminal (projected to plain metadata).
    expect(view.sessionTypes.map((t) => t.typeId)).toEqual(['terminal'])
    expect(view.sessionTypes[0]).not.toHaveProperty('createRuntime')
    expect(typeof view.sessionTypes[0].configSchema).toBe('object')

    // Settings + version carried straight through.
    expect(view.settings.defaultSessionTypeId).toBe('terminal')
    expect(view.version).toBe(1)
  })

  it('reflects an empty workspace on a fresh install', () => {
    const fd = makeDeps()
    const view = getState(fd.deps)
    expect(view.workspace.tasks).toEqual([])
    expect(view.workspace.activeTaskId).toBeUndefined()
    expect(view.sessionTypes.map((t) => t.typeId)).toEqual(['terminal'])
    expect(view.workspace.issues).toEqual([])
  })

  it('includes issues on view.workspace.issues after creating one (Issues §13.3, I19)', () => {
    const fd = makeDeps()
    const issueId = createIssue(fd.deps, { name: 'Fix', description: 'd' }).issueId!

    const view = getState(fd.deps)

    expect(view.workspace.issues).toHaveLength(1)
    expect(view.workspace.issues![0].id).toBe(issueId)
    expect(view.workspace.issues![0].name).toBe('Fix')
  })
})
