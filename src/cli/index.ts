import { homedir } from 'node:os'
import {
  OCTOPUS_CONTROL_SOCKET_ENV,
  resolveControlSocketPath,
  type IssuesGetResult
} from '../shared/control-protocol'
import { hostProfile } from '../shared/node/os/host'
import { parseCommand } from './args'
import { issueToMarkdown } from './format'
import {
  buildRequest,
  failureToOutcome,
  replyToOutcome,
  sendRequest,
  usageToOutcome,
  type CliOutcome
} from './client'

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8')
  let out = ''
  for await (const chunk of process.stdin) out += chunk as string
  return out
}

async function run(argv: readonly string[]): Promise<CliOutcome> {
  const cmd = parseCommand(argv)
  if (cmd.kind === 'help') return { exitCode: 0, stdout: cmd.text, stderr: '' }
  if (cmd.kind === 'usage') return usageToOutcome(cmd.message)

  const params = { ...cmd.params }
  if (cmd.stdinField !== undefined) {
    const text = await readStdin()
    // A command is one line: `echo cmd | octopus-cli ...` must not fail on its own newline.
    params[cmd.stdinField] = cmd.stdinField === 'command' ? text.replace(/[\r\n]+$/, '') : text
  }

  const socketPath =
    process.env[OCTOPUS_CONTROL_SOCKET_ENV] ||
    resolveControlSocketPath({ env: process.env, os: hostProfile(), home: homedir() })
  const res = await sendRequest(socketPath, buildRequest(cmd.method, params))
  if (!('reply' in res)) return failureToOutcome(res.failure)
  if (cmd.output === 'markdown' && res.reply.ok) {
    return { exitCode: 0, stdout: issueToMarkdown(res.reply.result as IssuesGetResult), stderr: '' }
  }
  return replyToOutcome(res.reply)
}

run(process.argv.slice(2)).then(
  (o) => {
    if (o.stdout) process.stdout.write(o.stdout)
    if (o.stderr) process.stderr.write(o.stderr)
    process.exitCode = o.exitCode
  },
  (e: unknown) => {
    process.stderr.write(JSON.stringify({ error: { code: 'internal', message: String(e) } }) + '\n')
    process.exitCode = 1
  }
)
