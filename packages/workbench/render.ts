import DOMPurify from 'dompurify';
import { marked } from 'marked';
import type { ReadingDocument } from '../host/contract.js';

const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export function renderReading(reading: ReadingDocument): string {
  let source = reading.document.markdown;
  const replacements: { start: number; end: number; html: string }[] = [];
  for (const ref of [...reading.mentions.filter(m => m.decorate), ...reading.links]) {
    if (ref.resolution.status !== 'resolved') continue;
    if (ref.resolution.candidates[0]?.documentId === reading.document.id) continue;
    const label = reading.document.parsed.wikiLinks.find(link => link.start === ref.evidence.start)?.label ?? ref.text;
    replacements.push({ start: ref.evidence.start, end: ref.evidence.end, html: `<button class="knowledge-mention" data-reference="${escape(ref.id)}" type="button" aria-label="预览 ${escape(label)}">${escape(label)}</button>` });
  }
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) source = source.slice(0, replacement.start) + replacement.html + source.slice(replacement.end);
  // Frontmatter remains in source and editor; reading presents the Markdown body.
  source = source.slice(reading.document.parsed.contentStart ?? 0);
  return DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true }), { USE_PROFILES: { html: true }, ADD_ATTR: ['data-reference'], FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'iframe', 'object', 'embed', 'video', 'audio'], FORBID_ATTR: ['style', 'srcset'] });
}
