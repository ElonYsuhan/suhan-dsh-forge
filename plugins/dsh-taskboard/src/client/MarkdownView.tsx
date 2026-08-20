/**
 * 依赖零的迷你 Markdown 渲染器（方案确认预览 / 冻结方案查看）。
 * 支持：标题、段落、粗体、斜体、行内代码、围栏代码块、无序/有序列表、
 * 链接、引用、分隔线。文本一律作为 React 子节点渲染，天然防 HTML 注入。
 */
import { createElement, type ReactNode } from 'react'

/** 行内片段 */
type InlinePart =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'bold'; children: InlinePart[] }
  | { kind: 'italic'; children: InlinePart[] }
  | { kind: 'link'; text: string; url: string }

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+?\*\*)|(\*[^*]+?\*)|(\[[^\]\n]+\]\([^)\n]+\))/g

/** 切分行内片段（code / bold / italic / link）。 */
function parseInline (text: string): InlinePart[] {
  const parts: InlinePart[] = []
  let last = 0
  for (const match of text.matchAll(INLINE_RE)) {
    const index = match.index ?? 0
    if (index > last) parts.push({ kind: 'text', text: text.slice(last, index) })
    const [, code, bold, italic, link] = match
    if (code !== undefined) parts.push({ kind: 'code', text: code.slice(1, -1) })
    else if (bold !== undefined) parts.push({ kind: 'bold', children: parseInline(bold.slice(2, -2)) })
    else if (italic !== undefined) parts.push({ kind: 'italic', children: parseInline(italic.slice(1, -1)) })
    else if (link !== undefined) {
      const close = link.lastIndexOf('](')
      parts.push({ kind: 'link', text: link.slice(1, close), url: link.slice(close + 2, -1) })
    }
    last = index + (match[0] ?? '').length
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) })
  return parts
}

/** 行内片段 → React 节点 */
function renderInline (parts: InlinePart[], keyBase: string): ReactNode {
  return parts.map((part, index) => {
    const key = `${keyBase}-${index}`
    switch (part.kind) {
      case 'text':
        return part.text
      case 'code':
        return <code key={key}>{part.text}</code>
      case 'bold':
        return <strong key={key}>{renderInline(part.children, key)}</strong>
      case 'italic':
        return <em key={key}>{renderInline(part.children, key)}</em>
      case 'link':
        return (
          <a key={key} href={part.url} target='_blank' rel='noreferrer'>
            {part.text === '' ? part.url : part.text}
          </a>
        )
    }
  })
}

/** 块类型 */
type Block =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }

const HEADING_RE = /^(#{1,6})\s+(.*)$/
const LIST_RE = /^(\s*)([-*]|\d+[.)])\s+(.*)$/
const QUOTE_RE = /^>\s?(.*)$/

/** 行集合 → 块列表（段落/列表/引用按连续行聚合，围栏代码跨行收集）。 */
function parseBlocks (text: string): Block[] {
  const lines = text.split(/\r?\n/)
  const blocks: Block[] = []
  let paragraph: string[] = []
  const flushParagraph = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
      paragraph = []
    }
  }
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '') {
      flushParagraph()
      index += 1
      continue
    }
    const fence = line.match(/^```/)
    if (fence !== null) {
      flushParagraph()
      const codeLines: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').trim().startsWith('```')) {
        codeLines.push(lines[index] ?? '')
        index += 1
      }
      index += 1 // 跳过结束围栏
      blocks.push({ kind: 'code', text: codeLines.join('\n') })
      continue
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      flushParagraph()
      blocks.push({ kind: 'hr' })
      index += 1
      continue
    }
    const heading = line.match(HEADING_RE)
    if (heading !== null) {
      flushParagraph()
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]! })
      index += 1
      continue
    }
    const quote = line.match(QUOTE_RE)
    if (quote !== null) {
      flushParagraph()
      const quoteLines: string[] = []
      while (index < lines.length && (lines[index] ?? '').match(QUOTE_RE) !== null) {
        quoteLines.push((lines[index] ?? '').replace(QUOTE_RE, '$1'))
        index += 1
      }
      blocks.push({ kind: 'quote', text: quoteLines.join('\n') })
      continue
    }
    const list = line.match(LIST_RE)
    if (list !== null) {
      flushParagraph()
      const ordered = (list[2] ?? '').match(/^\d+/) !== null
      const items: string[] = []
      while (index < lines.length) {
        const item = (lines[index] ?? '').match(LIST_RE)
        if (item === null) break
        items.push(item[3] ?? '')
        index += 1
      }
      blocks.push({ kind: 'list', ordered, items })
      continue
    }
    paragraph.push(line)
    index += 1
  }
  flushParagraph()
  return blocks
}

/** 块 → React 节点 */
function renderBlock (block: Block, key: string): ReactNode {
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(6, block.level + 1) // 面板内从 h2 起，避免与面板标题抢层级
      return createElement(`h${level}`, { key }, renderInline(parseInline(block.text), key))
    }
    case 'paragraph':
      return <p key={key}>{renderInline(parseInline(block.text), key)}</p>
    case 'code':
      return (
        <pre key={key}><code>{block.text}</code></pre>
      )
    case 'list':
      return block.ordered
        ? <ol key={key}>{block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(parseInline(item), `${key}-${i}`)}</li>)}</ol>
        : <ul key={key}>{block.items.map((item, i) => <li key={`${key}-${i}`}>{renderInline(parseInline(item), `${key}-${i}`)}</li>)}</ul>
    case 'quote':
      return <blockquote key={key}>{renderInline(parseInline(block.text), key)}</blockquote>
    case 'hr':
      return <hr key={key} />
  }
}

/** 迷你 Markdown 渲染器。 */
export function MarkdownView ({ text, className }: { text: string; className?: string | undefined }): ReactNode {
  return (
    <div className={className}>
      {parseBlocks(text).map((block, index) => renderBlock(block, String(index)))}
    </div>
  )
}
