import {
  INLINE_FLAG,
  type BlockModel,
  type BlockquoteBlock,
  type CodeBlock,
  type HeadingBlock,
  type HTMLBlock,
  type HTMLPolicy,
  type InlineModel,
  type ListItemBlock,
  type MathBlock,
  type TableBlock
} from '../types'
import { applyHTMLPolicy, escapeHTML, sanitizeResourceUrl } from './security'

export function renderInlineHTML(
  inlines: InlineModel[],
  policy: HTMLPolicy = 'sanitize'
): string {
  let html = ''
  let containsRawHTML = false
  for (const inline of inlines) {
    if (inline.type === 'text') {
      let text = escapeHTML(inline.text)
      if (inline.marks & INLINE_FLAG.CODE) {
        text = `<code>${text}</code>`
      } else {
        if (inline.marks & INLINE_FLAG.BOLD) text = `<strong>${text}</strong>`
        if (inline.marks & INLINE_FLAG.ITALIC) text = `<em>${text}</em>`
        if (inline.marks & INLINE_FLAG.STRIKE) text = `<del>${text}</del>`
        if (inline.marks & INLINE_FLAG.HIGHLIGHT) text = `<mark>${text}</mark>`
      }
      html += text
      continue
    }
    if (inline.type === 'link') {
      const href = sanitizeResourceUrl(inline.href, 'link')
      const attr = href === null ? '' : ` href="${escapeHTML(href)}"`
      html += `<a${attr}>${renderInlineHTML(inline.children, policy)}</a>`
      continue
    }
    if (inline.type === 'image') {
      const src = sanitizeResourceUrl(inline.src, 'image')
      const attr = src === null ? '' : ` src="${escapeHTML(src)}"`
      html += `<img${attr} alt="${escapeHTML(inline.alt)}" />`
      continue
    }
    if (inline.type === 'footnote-ref') {
      html += `<sup><a href="#fn-${escapeHTML(inline.id)}">${escapeHTML(inline.id)}</a></sup>`
      continue
    }
    if (inline.type === 'math') {
      html += `<span class="math-inline">${escapeHTML(inline.tex)}</span>`
      continue
    }
    if (inline.type === 'html-inline') {
      containsRawHTML = true
      html += policy === 'escape' ? escapeHTML(inline.raw) : inline.raw
    }
  }
  return containsRawHTML && policy === 'sanitize'
    ? applyHTMLPolicy(html, policy)
    : html
}

export function renderBlockHTML(
  block: BlockModel,
  policy: HTMLPolicy = 'sanitize'
): string {
  switch (block.type) {
    case 'heading': {
      const depth = (block as HeadingBlock).headingDepth
      return `<h${depth}>${renderInlineHTML(block.inline ?? [], policy)}</h${depth}>`
    }
    case 'paragraph':
      return `<p>${renderInlineHTML(block.inline ?? [], policy)}</p>`
    case 'list-item': {
      const style = (block as ListItemBlock).style
      if ('task' in style && style.task) {
        const checked = style.checked ? ' checked' : ''
        return `<li><input type="checkbox"${checked} disabled /> ${renderInlineHTML(block.inline ?? [], policy)}</li>`
      }
      return `<li>${renderInlineHTML(block.inline ?? [], policy)}</li>`
    }
    case 'hr':
      return '<hr />'
    case 'blank':
      return '<br />'
    case 'blockquote':
      return `<blockquote><p>${renderInlineHTML((block as BlockquoteBlock).inline ?? [], policy)}</p></blockquote>`
    case 'code-block': {
      const code = block as CodeBlock
      const language = code.language ? ` class="language-${escapeHTML(code.language)}"` : ''
      return `<pre><code${language}>${escapeHTML(code.code)}</code></pre>`
    }
    case 'math-block':
      return `<div class="math-block">${escapeHTML((block as MathBlock).tex)}</div>`
    case 'html-block':
      return applyHTMLPolicy((block as HTMLBlock).raw, policy)
    case 'table': {
      const table = block as TableBlock
      const header = table.headers.map((cell, index) => {
        const align = table.aligns[index] !== 'default'
          ? ` style="text-align:${table.aligns[index]}"`
          : ''
        const content = table.headerSlots?.[index]
          ? renderInlineHTML(table.headerSlots[index].inlines, policy)
          : escapeHTML(cell)
        return `<th${align}>${content}</th>`
      }).join('')
      const body = table.rows.map((row, rowIndex) =>
        `<tr>${row.map((cell, index) => {
          const align = table.aligns[index] !== 'default'
            ? ` style="text-align:${table.aligns[index]}"`
            : ''
          const content = table.rowSlots?.[rowIndex]?.[index]
            ? renderInlineHTML(table.rowSlots[rowIndex][index].inlines, policy)
            : escapeHTML(cell)
          return `<td${align}>${content}</td>`
        }).join('')}</tr>`
      ).join('\n')
      return `<table>\n<thead><tr>${header}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`
    }
    default:
      return `<p>${renderInlineHTML(block.inline ?? [], policy)}</p>`
  }
}
