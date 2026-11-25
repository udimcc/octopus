import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from './app-menu'

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((item) => [
    ...(item.role !== undefined ? [item.role] : []),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])
  ])

describe('appMenuTemplate', () => {
  it('is null (no menu bar) on linux and win32', () => {
    expect(appMenuTemplate('linux', 'Octopus')).toBeNull()
    expect(appMenuTemplate('win32', 'Octopus')).toBeNull()
  })

  it('on darwin has the app, Edit and Window menus only', () => {
    const t = appMenuTemplate('darwin', 'Octopus')!
    expect(t.map((m) => m.label)).toEqual(['Octopus', 'Edit', 'Window'])
    expect(roles(t)).toEqual([
      'about',
      'hide',
      'hideOthers',
      'unhide',
      'quit',
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'selectAll',
      'minimize',
      'zoom'
    ])
  })

  it('on darwin carries no reload/devtools/close roles', () => {
    const r = roles(appMenuTemplate('darwin', 'Octopus')!)
    for (const banned of ['reload', 'forceReload', 'toggleDevTools', 'close', 'viewMenu']) {
      expect(r).not.toContain(banned)
    }
  })
})
