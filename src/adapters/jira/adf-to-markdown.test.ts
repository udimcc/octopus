import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { adfToMarkdown } from './adf-to-markdown'

const FIXTURE_PATH = join(__dirname, '../../../test/fixtures/jira/get-issue-batch.json')

/** Pulls one issue's raw-text JSON block out of the batch fixture's single text payload. */
function loadFixtureIssue(key: string): Record<string, unknown> {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as { content: Array<{ text: string }> }
  const text = raw.content[0].text
  const match = new RegExp(`Issue ${key} details:\\n([\\s\\S]*?)(?:\\n\\n---\\n\\n|$)`).exec(text)
  if (!match) throw new Error(`fixture issue ${key} not found in ${FIXTURE_PATH}`)
  return JSON.parse(match[1]) as Record<string, unknown>
}

function text(value: string, marks?: unknown[]): Record<string, unknown> {
  return marks ? { type: 'text', text: value, marks } : { type: 'text', text: value }
}

function paragraph(...content: unknown[]): Record<string, unknown> {
  return { type: 'paragraph', content }
}

function doc(...content: unknown[]): Record<string, unknown> {
  return { type: 'doc', version: 1, content }
}

describe('adfToMarkdown — malformed input', () => {
  it('returns "" for null', () => {
    expect(adfToMarkdown(null)).toBe('')
  })

  it('returns "" for undefined', () => {
    expect(adfToMarkdown(undefined)).toBe('')
  })

  it('returns "" for a plain string', () => {
    expect(adfToMarkdown('not a doc')).toBe('')
  })

  it('returns "" for an object with no content array', () => {
    expect(adfToMarkdown({ type: 'doc', version: 1 })).toBe('')
  })

  it('returns "" when content is not an array', () => {
    expect(adfToMarkdown({ type: 'doc', content: 'oops' })).toBe('')
  })
})

describe('adfToMarkdown — block nodes', () => {
  it('paragraph renders its inline content', () => {
    expect(adfToMarkdown(doc(paragraph(text('Hello'))))).toBe('Hello')
  })

  it.each([1, 2, 3, 4, 5, 6])('heading level %i renders that many "#"', (level) => {
    const result = adfToMarkdown(
      doc({ type: 'heading', attrs: { level }, content: [text('Title')] })
    )
    expect(result).toBe(`${'#'.repeat(level)} Title`)
  })

  it('heading defaults to level 1 when attrs.level is missing', () => {
    const result = adfToMarkdown(doc({ type: 'heading', content: [text('Title')] }))
    expect(result).toBe('# Title')
  })

  it('heading clamps a level above 6 down to 6', () => {
    const result = adfToMarkdown(
      doc({ type: 'heading', attrs: { level: 9 }, content: [text('Title')] })
    )
    expect(result).toBe('###### Title')
  })

  it('bulletList renders each listItem as a "- " line', () => {
    const result = adfToMarkdown(
      doc({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [paragraph(text('Item'))] }]
      })
    )
    expect(result).toBe('- Item')
  })

  it('orderedList numbers items from attrs.order and increments', () => {
    const result = adfToMarkdown(
      doc({
        type: 'orderedList',
        attrs: { order: 5 },
        content: [
          { type: 'listItem', content: [paragraph(text('First'))] },
          { type: 'listItem', content: [paragraph(text('Second'))] }
        ]
      })
    )
    expect(result).toBe('5. First\n6. Second')
  })

  it('a nested bulletList inside a listItem renders indented under its parent item', () => {
    const result = adfToMarkdown(
      doc({
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            content: [
              paragraph(text('Parent')),
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [paragraph(text('Child'))] }]
              }
            ]
          }
        ]
      })
    )
    expect(result).toBe('- Parent\n  - Child')
  })

  it('taskList renders done/undone items as "- [x] "/"- [ ] "', () => {
    const result = adfToMarkdown(
      doc({
        type: 'taskList',
        content: [
          { type: 'taskItem', attrs: { state: 'DONE' }, content: [text('Done thing')] },
          { type: 'taskItem', attrs: { state: 'TODO' }, content: [text('Todo thing')] }
        ]
      })
    )
    expect(result).toBe('- [x] Done thing\n- [ ] Todo thing')
  })

  it('codeBlock fences its content with attrs.language on the opening fence', () => {
    const result = adfToMarkdown(
      doc({ type: 'codeBlock', attrs: { language: 'js' }, content: [text('const x = 1')] })
    )
    expect(result).toBe('```js\nconst x = 1\n```')
  })

  it('codeBlock without a language leaves the fence bare', () => {
    const result = adfToMarkdown(doc({ type: 'codeBlock', content: [text('plain')] }))
    expect(result).toBe('```\nplain\n```')
  })

  it('codeBlock uses a longer fence than any backtick run inside, and keeps internal blank lines untouched', () => {
    const content = 'func() {\n```\n  nested fence marker\n```\n}\n\n\n\nend'
    const result = adfToMarkdown(doc({ type: 'codeBlock', content: [text(content)] }))
    expect(result).toBe('````\n' + content + '\n````')
  })

  it("a codeBlock as a listItem's first block stays fence-aware (blank lines inside it are not collapsed)", () => {
    const content = 'x\n\n\ny'
    const result = adfToMarkdown(
      doc({
        type: 'bulletList',
        content: [{ type: 'listItem', content: [{ type: 'codeBlock', content: [text(content)] }] }]
      })
    )
    expect(result).toBe('- ```\n  x\n\n\n  y\n  ```')
  })

  it('rule renders as a markdown thematic break', () => {
    expect(adfToMarkdown(doc({ type: 'rule' }))).toBe('---')
  })

  it('table renders as a GFM pipe table with the first row as header, escaping "|" in cells', () => {
    const result = adfToMarkdown(
      doc({
        type: 'table',
        content: [
          {
            type: 'tableRow',
            content: [
              { type: 'tableHeader', content: [paragraph(text('Name'))] },
              { type: 'tableHeader', content: [paragraph(text('Age'))] }
            ]
          },
          {
            type: 'tableRow',
            content: [
              { type: 'tableCell', content: [paragraph(text('A|B'))] },
              { type: 'tableCell', content: [paragraph(text('30'))] }
            ]
          }
        ]
      })
    )
    expect(result).toBe('| Name | Age |\n| --- | --- |\n| A\\|B | 30 |')
  })

  it('media (via mediaSingle) renders as an attachment reference using attrs.alt', () => {
    const result = adfToMarkdown(
      doc({ type: 'mediaSingle', content: [{ type: 'media', attrs: { alt: 'screenshot.png' } }] })
    )
    expect(result).toBe('[attachment: screenshot.png]')
  })

  it('media with no alt/fileName falls back to a bare "[attachment]"', () => {
    const result = adfToMarkdown(doc({ type: 'mediaSingle', content: [{ type: 'media' }] }))
    expect(result).toBe('[attachment]')
  })

  it('expand renders a bold title line, then the content', () => {
    const result = adfToMarkdown(
      doc({
        type: 'expand',
        attrs: { title: 'Details' },
        content: [paragraph(text('Hidden text'))]
      })
    )
    expect(result).toBe('**Details**\n\nHidden text')
  })

  it.each(['blockCard', 'embedCard'])('%s renders as a markdown link to attrs.url', (type) => {
    const result = adfToMarkdown(doc({ type, attrs: { url: 'https://example.com' } }))
    expect(result).toBe('[https://example.com](https://example.com)')
  })

  it('status (inline) renders its attrs.text label', () => {
    const result = adfToMarkdown(
      doc(paragraph(text('State: '), { type: 'status', attrs: { text: 'Done' } }, text('!')))
    )
    expect(result).toBe('State: Done!')
  })

  it('hardBreak renders as a newline between two text runs', () => {
    const result = adfToMarkdown(doc(paragraph(text('a'), { type: 'hardBreak' }, text('b'))))
    expect(result).toBe('a\nb')
  })
})

describe('adfToMarkdown — marks, fixed application order code→strike→em→strong→link', () => {
  it('code wraps text in a single backtick when it contains no backticks', () => {
    const result = adfToMarkdown(doc(paragraph(text('x', [{ type: 'code' }]))))
    expect(result).toBe('`x`')
  })

  it('code uses a longer fence when the text itself contains a backtick', () => {
    const result = adfToMarkdown(doc(paragraph(text('a`b', [{ type: 'code' }]))))
    expect(result).toBe('``a`b``')
  })

  it('strike wraps with "~~", moving surrounding whitespace outside the delimiters', () => {
    // The marked whitespace sits mid-document (flanked by "a"/"b") so the final
    // document-level trim doesn't swallow it, unlike whitespace at the very edge.
    const result = adfToMarkdown(
      doc(paragraph(text('a'), text(' x ', [{ type: 'strike' }]), text('b')))
    )
    expect(result).toBe('a ~~x~~ b')
  })

  it('em wraps with "*"', () => {
    const result = adfToMarkdown(doc(paragraph(text('x', [{ type: 'em' }]))))
    expect(result).toBe('*x*')
  })

  it('strong wraps with "**"', () => {
    const result = adfToMarkdown(doc(paragraph(text('x', [{ type: 'strong' }]))))
    expect(result).toBe('**x**')
  })

  it('link wraps as [text](href) when href is a string', () => {
    const result = adfToMarkdown(
      doc(paragraph(text('click', [{ type: 'link', attrs: { href: 'https://x.test' } }])))
    )
    expect(result).toBe('[click](https://x.test)')
  })

  it('link is skipped (text passes through unlinked) when href is not a string', () => {
    const result = adfToMarkdown(
      doc(paragraph(text('click', [{ type: 'strong' }, { type: 'link', attrs: { href: 42 } }])))
    )
    expect(result).toBe('**click**')
  })

  it('em+strong combine as "***x***" regardless of their order in the marks array', () => {
    const result = adfToMarkdown(doc(paragraph(text('x', [{ type: 'em' }, { type: 'strong' }]))))
    expect(result).toBe('***x***')
  })

  it('code+strong nest code innermost: "**`y`**"', () => {
    const result = adfToMarkdown(doc(paragraph(text('y', [{ type: 'strong' }, { type: 'code' }]))))
    expect(result).toBe('**`y`**')
  })

  it('applies all five marks in the fixed order code→strike→em→strong→link, no matter how the ADF lists them', () => {
    const result = adfToMarkdown(
      doc(
        paragraph(
          text('Z', [
            { type: 'link', attrs: { href: 'https://e.com' } },
            { type: 'strong' },
            { type: 'em' },
            { type: 'strike' },
            { type: 'code' }
          ])
        )
      )
    )
    expect(result).toBe('[***~~`Z`~~***](https://e.com)')
  })
})

describe('adfToMarkdown — unknown nodes', () => {
  it('an unknown node with inline children renders them inline', () => {
    const result = adfToMarkdown(doc({ type: 'someFutureNode', content: [text('fallback text')] }))
    expect(result).toBe('fallback text')
  })

  it('an unknown node with block children renders them as blocks, separated by a blank line', () => {
    const result = adfToMarkdown(
      doc({
        type: 'someFutureContainer',
        content: [paragraph(text('P1')), paragraph(text('P2'))]
      })
    )
    expect(result).toBe('P1\n\nP2')
  })

  it('an unknown leaf node (no content) falls back to its own .text', () => {
    const result = adfToMarkdown(doc({ type: 'someFutureLeaf', text: 'leaf text' }))
    expect(result).toBe('leaf text')
  })
})

describe('adfToMarkdown — blank-line collapsing and trimming', () => {
  it('collapses a run of 3+ blank lines (outside any code fence) down to one', () => {
    const result = adfToMarkdown(
      doc(
        paragraph(
          text('a'),
          { type: 'hardBreak' },
          { type: 'hardBreak' },
          { type: 'hardBreak' },
          { type: 'hardBreak' },
          text('b')
        )
      )
    )
    expect(result).toBe('a\n\nb')
  })
})

describe('adfToMarkdown — MAX_DEPTH fallback', () => {
  it('nesting far past MAX_DEPTH never throws and still surfaces the leaf text as plain text', () => {
    let node: unknown = paragraph(text('deep leaf'))
    for (let i = 0; i < 120; i++) {
      node = { type: 'blockquote', content: [node] }
    }
    const input = doc(node)

    let result = ''
    expect(() => {
      result = adfToMarkdown(input)
    }).not.toThrow()
    expect(typeof result).toBe('string')
    expect(result).toContain('deep leaf')
  })
})

describe('adfToMarkdown — real fixture data (test/fixtures/jira/get-issue-batch.json, TM-2608)', () => {
  const tm2608 = loadFixtureIssue('TM-2608')

  it('renders the "dod" ADF field as a single-line paragraph', () => {
    expect(tm2608.dod).toEqual({
      type: 'doc',
      version: 1,
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'CI passes' }] }]
    })
    expect(adfToMarkdown(tm2608.dod)).toBe('CI passes')
  })

  it('renders the "Description" ADF field, a paragraph with a hardBreak, trimming the trailing space before it', () => {
    const result = adfToMarkdown(tm2608.Description)
    expect(result).toBe(
      'On: FieldMarket + CoreInstaller + Brainiac, we get an error unknown key OPENSTACK_USERNAME\n' +
        'Meaning we got problems to propergate this parameter'
    )
  })
})
