import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from './app-menu'
import { osProfile } from '../shared/os'

const roles = (items: MenuItemConstructorOptions[]): string[] =>
  items.flatMap((item) => [
    ...(item.role !== undefined ? [item.role] : []),
    ...(Array.isArray(item.submenu) ? roles(item.submenu) : [])
  ])

describe('appMenuTemplate', () => {
  it('is null (no menu bar) on linux and win32', () => {
    expect(appMenuTemplate(osProfile('linux').app.appMenu, 'Octopus')).toBeNull()
    expect(appMenuTemplate(osProfile('win32').app.appMenu, 'Octopus')).toBeNull()
  })

  it('on darwin has the app, Edit and Window menus only', () => {
    const t = appMenuTemplate(osProfile('darwin').app.appMenu, 'Octopus')!
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
    const r = roles(appMenuTemplate(osProfile('darwin').app.appMenu, 'Octopus')!)
    for (const banned of ['reload', 'forceReload', 'toggleDevTools', 'close', 'viewMenu']) {
      expect(r).not.toContain(banned)
    }
  })
})
