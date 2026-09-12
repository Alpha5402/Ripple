/** Textareas normalize newlines to LF. Apply their smallest edit back to the original source. */
export const textareaSource = (source: string): string => source.replace(/\r\n?/g, '\n');
export function applyTextareaEdit(source: string, display: string): string {
  const previous = textareaSource(source);
  if (display === previous) return source;
  let start = 0, suffix = 0;
  while (start < previous.length && start < display.length && previous[start] === display[start]) start++;
  while (suffix < previous.length - start && suffix < display.length - start && previous[previous.length - 1 - suffix] === display[display.length - 1 - suffix]) suffix++;
  const rawOffset = (normalized: number) => {
    let raw = 0, offset = 0;
    while (offset < normalized && raw < source.length) { raw += source[raw] === '\r' && source[raw + 1] === '\n' ? 2 : 1; offset++; }
    return raw;
  };
  const newline = /\r\n|\r|\n/.exec(source)?.[0] ?? '\n';
  const inserted = display.slice(start, display.length - suffix).replace(/\n/g, newline);
  return source.slice(0, rawOffset(start)) + inserted + source.slice(rawOffset(previous.length - suffix));
}
