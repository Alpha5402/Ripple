/// <reference lib="es2022.intl" />

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

export function previousGraphemeBoundary(text: string, offset: number): number {
  let previous = 0
  for (const segment of segmenter.segment(text)) {
    if (segment.index >= offset) break
    previous = segment.index
  }
  return previous
}

export function nextGraphemeBoundary(text: string, offset: number): number {
  for (const segment of segmenter.segment(text)) {
    if (segment.index > offset) return segment.index
  }
  return text.length
}
