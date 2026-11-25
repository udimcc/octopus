import { describe, it, expect } from 'vitest'
import { realpathSync } from 'node:fs'
import { parseLsofCwd, procCwds, procCwdAsync } from './proc-cwd'
import { hostProfile } from './os/host'

describe('parseLsofCwd', () => {
  it('maps each process set to its cwd name', () => {
    const out = 'p101\nfcwd\nn/Users/me/repo\np202\nfcwd\nn/private/tmp/with space\n'
    expect(parseLsofCwd(out)).toEqual(
      new Map([
        [101, '/Users/me/repo'],
        [202, '/private/tmp/with space']
      ])
    )
  })

  it('ignores names of non-cwd files, junk lines and a malformed pid', () => {
    const out = 'p1\nftxt\nn/bin/zsh\nfcwd\nn/home\npabc\nfcwd\nn/nope\nxjunk\n\n'
    expect(parseLsofCwd(out)).toEqual(new Map([[1, '/home']]))
  })

  it('is empty for empty output', () => {
    expect(parseLsofCwd('')).toEqual(new Map())
  })
})

const probe = hostProfile().proc.cwdProbe
const supported = probe !== 'none'

describe.skipIf(!supported)('procCwds (real OS)', () => {
  it("resolves this process's cwd and omits a pid that does not exist", async () => {
    const missing = 2 ** 22 + 12345 // above Linux pid_max default and macOS's 99999
    const got = await procCwds([process.pid, missing, process.pid], probe)
    expect(realpathSync(got.get(process.pid)!)).toBe(realpathSync(process.cwd()))
    expect(got.has(missing)).toBe(false)
    await expect(procCwdAsync(missing, probe)).resolves.toBeUndefined()
  })

  it('returns an empty map for no (or invalid) pids without spawning anything', async () => {
    await expect(procCwds([], probe)).resolves.toEqual(new Map())
    await expect(procCwds([0, -1, 1.5], probe)).resolves.toEqual(new Map())
  })
})

describe("procCwds ('none' probe)", () => {
  it('resolves nothing and spawns nothing', async () => {
    await expect(procCwds([process.pid], 'none')).resolves.toEqual(new Map())
    await expect(procCwdAsync(process.pid, 'none')).resolves.toBeUndefined()
  })
})
