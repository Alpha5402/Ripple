// src/core/parser.ts
import { LineModel, LineBlock } from './types';

export function escapeHTML(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const inlineParse = (text: string): string => {
  return text
    .replace(/`([^`\n]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*(.*?)\*\*/g, '<span class="md-bold">$1</span>')
    .replace(/\*([^*]+)\*/g, '<span class="md-italic">$1</span>')
    .replace(/_([^_]+)_/g, '<span class="md-italic">$1</span>')
    .replace(/~~(.*?)~~/g, '<span class="md-strikethrough">$1</span>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g, 
      '<a href="$2" target="_blank" class="md-link">$1</a>'
    );
}

export function parseLine(model: LineModel): LineBlock {
  const { raw, indent } = model

  if (raw.trim() === '') {
    return {
      id: model.id,
      type: 'blank',
    }
  }

  if (/^\s*[-*+]\s/.test(raw)) {
    const prefix = raw.match(/^(\s*[-*+]\s)/)![1]
    const content = raw.slice(prefix.length)

    return {
      id: model.id,
      type: 'list-item',
      indent,
      prefix: { text: '•', className: 'md-list-marker' },
      content: { html: inlineParse(escapeHTML(content)) }
    }
  } else if (/^(\s*)(\d+)\.\s/.test(raw)) {
    const prefix = raw.match(/^(\s*)(\d+)\.\s/)![0]
    const content = raw.slice(prefix.length)

    return {
      id: model.id,
      type: 'list-item',
      indent,
      prefix: { text: prefix, className: 'md-list-marker' },
      content: { html: inlineParse(escapeHTML(content)) }
    }
  } else if (/^(#{1,6})\s+(.*)$/.test(raw)) {
    const match = raw.match(/^(#{1,6})\s+(.*)$/)!
    const level = match[1].length
    const content = match[2]
    return {
      id: model.id,
      type: 'heading',
      indent,
      content: { 
        html: inlineParse(escapeHTML(content)),
        className: `md-heading-${level}`
      }
    }
  }

  // paragraph
  return {
    id: model.id,
    type: 'paragraph',
    indent,
    content: { html: inlineParse(escapeHTML(raw.trim())) }
  }
}
