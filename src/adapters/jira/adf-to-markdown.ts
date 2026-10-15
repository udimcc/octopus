/**
 * Pure, dependency-free ADF (Atlassian Document Format) → Markdown converter.
 *
 * ADF is the `{type:'doc', version:1, content:[...]}` tree Jira returns for rich-text
 * fields (Description, the `dod` custom field). The LiteLLM Jira adapter uses it to
 * render those fields for the renderer's markdown viewer (GFM, `IssueMarkdown.tsx`) and
 * for classification. The output is effectively **stored data**: classification compares
 * an imported issue's description with a fresh conversion byte-for-byte, so any later
 * output change turns every unedited imported issue into a Conflict. It must therefore be
 * deterministic — no trailing whitespace and no runs of 3+ blank lines outside code
 * fences, code-fence content untouched, the whole string trimmed.
 *
 * Every property access is guarded — `doc` (and every node within it) is `unknown` and
 * may be malformed, partial, or simply not ADF. Nothing here ever throws: unrecognized
 * shapes fall back to best-effort text, and nesting deeper than {@link MAX_DEPTH}
 * collapses to plain text (so a pathological tree can't overflow the stack).
 *
 * Block nodes: `paragraph`, `heading` (1-6), `bulletList`/`orderedList`/`listItem`
 * (nested; an item's later paragraphs stay inside the item), `taskList`/`taskItem`
 * (`- [ ]` / `- [x]`), `decisionList`/`decisionItem` (`- `), `codeBlock` (fenced,
 * optional `attrs.language`, fence longer than any backtick run inside), `blockquote`,
 * `panel` (rendered as a blockquote), `expand`/`nestedExpand` (bold title line, then the
 * content), `table` (GFM pipe table; the first row is the header), `rule`,
 * `mediaSingle`/`mediaGroup`/`media` (`[attachment: <alt|name>]`), `blockCard`/
 * `embedCard` (link). Inline nodes: `text` (with marks), `hardBreak`, `mention`, `emoji`,
 * `inlineCard`, `status` (its label), `date`, `mediaInline`. Any other node renders its
 * `content` (inline or block, by what the children are), else its `text`, else nothing.
 *
 * Marks on `text`: `code`, `strike` (`~~`), `em` (`*`), `strong` (`**`), `link`
 * (`[text](href)`), applied in that fixed order (innermost first) whatever order ADF
 * lists them in. Emphasis delimiters hug the text — surrounding whitespace is moved
 * outside them, since `**bold **` would not render. Plain text is NOT markdown-escaped:
 * descriptions stay readable when edited in Octopus.
 */

type AdfRecord = Record<string, unknown>

/** Deeper nesting than this renders as plain text — see the module doc. */
const MAX_DEPTH = 64

/** Inline node types — a container holding any of these renders its content inline. */
const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'inlineCard',
  'status',
  'date',
  'mediaInline',
  'placeholder',
  'inlineExtension'
])

/** Lists that nest directly under a list item's first line (no blank line between). */
const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList', 'decisionList'])

/** Fixed mark order, innermost first, so output never depends on ADF's mark order. */
const MARK_ORDER = ['code', 'strike', 'em', 'strong', 'link']

function isRecord(value: unknown): value is AdfRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asArray(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined
}

function asAttrs(node: AdfRecord): AdfRecord | undefined {
  return isRecord(node.attrs) ? node.attrs : undefined
}

function typeOf(node: unknown): string | undefined {
  return isRecord(node) ? asString(node.type) : undefined
}

/** Converts an ADF document to markdown. Never throws; malformed input yields `''`. */
export function adfToMarkdown(doc: unknown): string {
  if (!isRecord(doc)) return ''
  const content = asArray(doc.content)
  if (!content) return ''
  return normalize(renderBlocks(content, 0))
}

/**
 * Strips trailing whitespace and collapses blank-line runs to one — outside code fences
 * only, so code keeps its exact whitespace — then trims the whole string. A fence line is
 * recognized after its indentation, `>` quote prefix and list / task markers.
 */
function normalize(text: string): string {
  const out: string[] = []
  let openFence: string | undefined
  let blankRun = 0
  for (const line of text.split('\n')) {
    const body = line.replace(/^(?:[\s>]|[-*+] |\d+\. |\[[ x]\] )*/, '')
    if (openFence !== undefined) {
      out.push(line)
      if (body.trimEnd() === openFence) openFence = undefined
      continue
    }
    const fence = /^`{3,}/.exec(body)
    if (fence) openFence = fence[0]
    const stripped = line.replace(/[ \t]+$/, '')
    if (stripped === '') {
      blankRun += 1
      if (blankRun > 1) continue
    } else {
      blankRun = 0
    }
    out.push(stripped)
  }
  return out.join('\n').trim()
}

/** Renders a sequence of block-level nodes, separated by a blank line. */
function renderBlocks(nodes: unknown[], depth: number): string {
  const parts: string[] = []
  for (const node of nodes) {
    const rendered = renderBlock(node, depth)
    if (rendered !== '') parts.push(rendered)
  }
  return parts.join('\n\n')
}

function renderBlock(node: unknown, depth: number): string {
  if (!isRecord(node)) return ''
  if (depth > MAX_DEPTH) return plainText(node)
  const content = asArray(node.content) ?? []
  switch (asString(node.type)) {
    case 'paragraph':
      return renderInline(content, depth)
    case 'heading': {
      const level = headingLevel(asAttrs(node))
      return `${'#'.repeat(level)} ${renderInline(content, depth)}`
    }
    case 'bulletList':
    case 'orderedList':
      return renderList(node, depth)
    case 'taskList':
    case 'decisionList':
      return renderTaskList(node, depth)
    case 'codeBlock': {
      const language = asString(asAttrs(node)?.language) ?? ''
      const text = plainText(node)
      const fence = '`'.repeat(Math.max(3, longestRun(text, '`') + 1))
      return `${fence}${language}\n${text}\n${fence}`
    }
    case 'blockquote':
    case 'panel':
      return quote(renderBlocks(content, depth + 1))
    case 'expand':
    case 'nestedExpand': {
      const title = asString(asAttrs(node)?.title)?.trim()
      const body = renderBlocks(content, depth + 1)
      return [title ? `**${title}**` : '', body].filter((part) => part !== '').join('\n\n')
    }
    case 'table':
      return renderTable(node, depth)
    case 'rule':
      return '---'
    case 'mediaSingle':
    case 'mediaGroup':
      return content
        .map((child) => renderBlock(child, depth + 1))
        .filter((part) => part !== '')
        .join('\n')
    case 'media':
      return renderMedia(asAttrs(node))
    case 'blockCard':
    case 'embedCard':
      return renderCard(asAttrs(node))
    case 'text':
      return applyMarks(asString(node.text) ?? '', asArray(node.marks))
    default:
      return renderUnknown(node, depth)
  }
}

/** Unknown container: inline children render as inline text (with marks), block
 * children as blocks; a leaf falls back to its `text`. */
function renderUnknown(node: AdfRecord, depth: number): string {
  const content = asArray(node.content)
  if (!content) return asString(node.text) ?? ''
  const hasInline = content.some((child) => INLINE_TYPES.has(typeOf(child) ?? ''))
  return hasInline ? renderInline(content, depth + 1) : renderBlocks(content, depth + 1)
}

function quote(inner: string): string {
  return inner
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n')
}

function headingLevel(attrs: AdfRecord | undefined): number {
  const raw = attrs?.level
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  if (!Number.isFinite(n)) return 1
  return Math.min(6, Math.max(1, Math.floor(n)))
}

function renderList(node: AdfRecord, depth: number): string {
  const isOrdered = asString(node.type) === 'orderedList'
  let order = startOrder(isOrdered, asAttrs(node))
  const lines: string[] = []
  for (const item of asArray(node.content) ?? []) {
    if (!isRecord(item) || asString(item.type) !== 'listItem') continue
    const marker = isOrdered ? `${order}. ` : '- '
    lines.push(renderListItem(asArray(item.content) ?? [], marker, depth + 1))
    if (isOrdered) order += 1
  }
  return lines.join('\n')
}

/** `taskList`/`decisionList`: items hold inline content directly; a nested list of the
 * same kind appears as a sibling item and is indented under the previous item. */
function renderTaskList(node: AdfRecord, depth: number): string {
  if (depth > MAX_DEPTH) return plainText(node)
  const lines: string[] = []
  for (const item of asArray(node.content) ?? []) {
    if (!isRecord(item)) continue
    const type = asString(item.type)
    if (type === 'taskItem' || type === 'decisionItem') {
      const done = asString(asAttrs(item)?.state) === 'DONE'
      const marker = type === 'taskItem' ? (done ? '- [x] ' : '- [ ] ') : '- '
      const text = renderInline(asArray(item.content) ?? [], depth + 1)
      lines.push(text === '' ? marker.trimEnd() : hangIndent(marker, text, '  '))
    } else if (type === 'taskList' || type === 'decisionList') {
      const nested = renderTaskList(item, depth + 1)
      if (nested !== '') lines.push(indentLines(nested, '  '))
    }
  }
  return lines.join('\n')
}

function startOrder(isOrdered: boolean, attrs: AdfRecord | undefined): number {
  if (!isOrdered) return 1
  const raw = attrs?.order
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1
}

/** Renders one `listItem`: its first block sits on the marker's line; later blocks are
 * indented by the marker's width. A nested list follows directly; any other block is
 * separated by a blank line so markdown keeps it inside the item as its own paragraph. */
function renderListItem(blocks: unknown[], marker: string, depth: number): string {
  const indent = ' '.repeat(marker.length)
  let out = ''
  for (const block of blocks) {
    const rendered = renderBlock(block, depth)
    if (rendered === '') continue
    if (out === '') {
      out = hangIndent(marker, rendered, indent)
    } else {
      const separator = LIST_TYPES.has(typeOf(block) ?? '') ? '\n' : '\n\n'
      out += separator + indentLines(rendered, indent)
    }
  }
  return out === '' ? marker.trimEnd() : out
}

/** `marker` + first line, later lines indented by `indent`. */
function hangIndent(marker: string, text: string, indent: string): string {
  const [first, ...rest] = text.split('\n')
  return [marker + first, ...rest.map((line) => (line === '' ? '' : indent + line))].join('\n')
}

function indentLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line) => (line === '' ? '' : indent + line))
    .join('\n')
}

/** GFM pipe table. Cells are flattened to one line with `|` escaped; the first row is
 * the header (GFM requires one); short rows are padded to the widest row. */
function renderTable(node: AdfRecord, depth: number): string {
  const rows: string[][] = []
  for (const row of asArray(node.content) ?? []) {
    if (!isRecord(row) || asString(row.type) !== 'tableRow') continue
    const cells: string[] = []
    for (const cell of asArray(row.content) ?? []) {
      if (!isRecord(cell)) continue
      const text = renderBlocks(asArray(cell.content) ?? [], depth + 1)
      cells.push(
        text
          .replace(/\s*\n\s*/g, ' ')
          .replace(/\|/g, '\\|')
          .trim()
      )
    }
    rows.push(cells)
  }
  let width = 0
  for (const cells of rows) width = Math.max(width, cells.length)
  if (width === 0) return ''
  const line = (cells: string[]): string =>
    '| ' + Array.from({ length: width }, (_, i) => cells[i] ?? '').join(' | ') + ' |'
  const [header, ...body] = rows
  return [line(header), line(Array(width).fill('---')), ...body.map(line)].join('\n')
}

/** Renders a sequence of inline nodes, concatenated with no separator. */
function renderInline(nodes: unknown[], depth: number): string {
  let out = ''
  for (const node of nodes) {
    out += renderInlineNode(node, depth)
  }
  return out
}

function renderInlineNode(node: unknown, depth: number): string {
  if (!isRecord(node)) return ''
  if (depth > MAX_DEPTH) return plainText(node)
  const attrs = asAttrs(node)
  switch (asString(node.type)) {
    case 'text':
      return applyMarks(asString(node.text) ?? '', asArray(node.marks))
    case 'hardBreak':
      return '\n'
    case 'mention':
      return renderMention(attrs)
    case 'emoji':
      return asString(attrs?.text) ?? asString(attrs?.shortName) ?? ''
    case 'inlineCard':
      return renderCard(attrs)
    case 'status':
      return asString(attrs?.text) ?? ''
    case 'date':
      return renderDate(attrs)
    case 'mediaInline':
      return renderMedia(attrs)
    case 'placeholder':
      // Editor hint text for an empty field, not content.
      return ''
    default: {
      const content = asArray(node.content)
      return content ? renderInline(content, depth + 1) : (asString(node.text) ?? '')
    }
  }
}

function applyMarks(text: string, marks: unknown[] | undefined): string {
  if (!marks || text === '') return text
  const byType = new Map<string, AdfRecord>()
  for (const mark of marks) {
    const type = typeOf(mark)
    if (type !== undefined && isRecord(mark)) byType.set(type, mark)
  }
  let result = text
  for (const type of MARK_ORDER) {
    const mark = byType.get(type)
    if (!mark) continue
    switch (type) {
      case 'code':
        result = codeSpan(result)
        break
      case 'strike':
        result = wrapHugging(result, '~~')
        break
      case 'em':
        result = wrapHugging(result, '*')
        break
      case 'strong':
        result = wrapHugging(result, '**')
        break
      case 'link': {
        const href = asString(asAttrs(mark)?.href)
        if (href) result = `[${result}](${href})`
        break
      }
    }
  }
  return result
}

/** Wraps `text` in `delimiter`, keeping leading/trailing whitespace outside it. */
function wrapHugging(text: string, delimiter: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)
  if (!match || match[2] === '') return text
  return `${match[1]}${delimiter}${match[2]}${delimiter}${match[3]}`
}

/** A code span whose fence is longer than any backtick run inside, padded with a space
 * when the content starts or ends with a backtick (CommonMark code-span rules). */
function codeSpan(text: string): string {
  const fence = '`'.repeat(longestRun(text, '`') + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

function longestRun(text: string, char: string): number {
  let longest = 0
  let current = 0
  for (const c of text) {
    current = c === char ? current + 1 : 0
    if (current > longest) longest = current
  }
  return longest
}

function renderMention(attrs: AdfRecord | undefined): string {
  if (!attrs) return ''
  const text = asString(attrs.text)
  if (text) return text
  const id = asString(attrs.id)
  return id ? `@${id}` : ''
}

function renderCard(attrs: AdfRecord | undefined): string {
  const url = asString(attrs?.url)
  return url ? `[${url}](${url})` : ''
}

function renderMedia(attrs: AdfRecord | undefined): string {
  const name = (asString(attrs?.alt) ?? asString(attrs?.fileName) ?? '').trim()
  return name ? `[attachment: ${name}]` : '[attachment]'
}

function renderDate(attrs: AdfRecord | undefined): string {
  const raw = attrs?.timestamp
  const ms = typeof raw === 'string' ? Number(raw) : typeof raw === 'number' ? raw : NaN
  if (!Number.isFinite(ms)) return ''
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return ''
  return date.toISOString().slice(0, 10)
}

/**
 * Plain-text extraction: `text` leaves concatenated, `hardBreak` as a newline. Used for
 * `codeBlock` content (unmarked `text` per the ADF spec) and for subtrees past
 * {@link MAX_DEPTH}. Iterative (explicit stack), so it can't overflow on any depth.
 */
function plainText(root: AdfRecord): string {
  let out = ''
  const stack: unknown[] = [...(asArray(root.content) ?? [])].reverse()
  if (stack.length === 0) return asString(root.text) ?? ''
  while (stack.length > 0) {
    const node = stack.pop()
    if (!isRecord(node)) continue
    const type = asString(node.type)
    if (type === 'hardBreak') {
      out += '\n'
      continue
    }
    const content = asArray(node.content)
    if (type !== 'text' && content) {
      for (let i = content.length - 1; i >= 0; i -= 1) stack.push(content[i])
    } else {
      out += asString(node.text) ?? ''
    }
  }
  return out
}
