import DOMPurify from 'dompurify'
import type { HTMLPolicy } from '../types'

const SAFE_DATA_IMAGE = /^data:image\/(?:png|gif|jpe?g|webp);base64,/i

/**
 * Convert an untrusted Markdown destination into a URL that is safe to assign
 * to a DOM href/src attribute. The source text itself is never rewritten.
 */
export function sanitizeResourceUrl(
  value: string,
  kind: 'link' | 'image' = 'link'
): string | null {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f\s]+/g, '')
  if (normalized === '') return ''

  if (kind === 'image' && SAFE_DATA_IMAGE.test(normalized)) {
    return value
  }

  const scheme = normalized.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
  if (!scheme) return value

  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto' || scheme === 'tel') {
    return value
  }

  return null
}

export function escapeHTML(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function applyHTMLPolicy(value: string, policy: HTMLPolicy): string {
  if (policy === 'trusted') return value
  if (policy === 'escape') return escapeHTML(value)

  if (typeof DOMPurify.sanitize !== 'function') {
    return escapeHTML(value)
  }

  return DOMPurify.sanitize(value, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['svg', 'math'],
    FORBID_ATTR: ['style']
  }) as string
}
