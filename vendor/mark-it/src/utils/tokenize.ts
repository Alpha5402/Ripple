// src/utils/tokenize
import { RawLine } from '../types';
import type { SourceRange } from './SourceDocument';

export const uid = () => crypto.randomUUID();

export function tokenizeByLine(raw: string, oldId?: string): RawLine {  
  const leading = raw.match(/^[ \t]*/)?.[0] ?? '';

  return {
    id: oldId ?? uid(),
    raw,
    leading
  }
} 

/**
 * 检测一行是否是围栏代码块的起止标记（``` 或 ~~~）
 * 返回语言标注（仅对开启行有效），或 null 表示不是围栏标记
 */
function matchCodeFence(line: string): { marker: string; language: string } | null {
  const match = line.match(/^(`{3,}|~{3,})\s*(.*)$/)
  if (!match) return null
  return { marker: match[1], language: match[2].trim() }
}

/**
 * 检测一行是否是表格行（以 | 开头或包含 | 分隔）
 */
function isTableRow(line: string): boolean {
  return splitTableRow(line) !== null
}

/**
 * 检测一行是否是表格分隔行（如 |---|---|）
 */
function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line)
  return cells !== null && cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell.trim()))
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return null

  const cells: string[] = []
  let cell = ''
  let escaped = false
  let separatorCount = 0

  for (let index = 0; index < trimmed.length; index += 1) {
    const char = trimmed[index]
    if (escaped) {
      cell += char
      escaped = false
      continue
    }
    if (char === '\\') {
      cell += char
      escaped = true
      continue
    }
    if (char === '|') {
      cells.push(cell)
      cell = ''
      separatorCount += 1
      continue
    }
    cell += char
  }
  cells.push(cell)

  if (separatorCount === 0) return null
  if (trimmed.startsWith('|')) cells.shift()
  if (trimmed.endsWith('|')) cells.pop()
  return cells
}

export interface SourceToken extends RawLine {
  range: SourceRange
}

type PhysicalLine = {
  text: string
  start: number
  end: number
  breakEnd: number
}

function splitPhysicalLines(source: string): PhysicalLine[] {
  const lines: PhysicalLine[] = []
  let start = 0
  let index = 0

  while (index < source.length) {
    const char = source[index]
    if (char !== '\n' && char !== '\r') {
      index += 1
      continue
    }

    const breakEnd = char === '\r' && source[index + 1] === '\n' ? index + 2 : index + 1
    lines.push({ text: source.slice(start, index), start, end: index, breakEnd })
    start = breakEnd
    index = breakEnd
  }

  lines.push({ text: source.slice(start), start, end: source.length, breakEnd: source.length })
  return lines
}

const HTML_BLOCK_TAG = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:\s|\/?>)/i

function htmlBlockEnd(lines: PhysicalLine[], start: number): number | null {
  const text = lines[start].text.trimStart()
  if (!text.startsWith('<')) return null

  const untilMarker = (marker: string): number => {
    let end = start
    while (end < lines.length && !lines[end].text.includes(marker)) end += 1
    return Math.min(end, lines.length - 1)
  }

  if (text.startsWith('<!--')) return untilMarker('-->')
  if (text.startsWith('<?')) return untilMarker('?>')
  if (text.startsWith('<![CDATA[')) return untilMarker(']]>')
  if (/^<![A-Z]/.test(text)) return untilMarker('>')

  const rawTag = text.match(/^<(script|pre|style|textarea)(?:\s|>|$)/i)?.[1]
  if (rawTag) return untilMarker(`</${rawTag}>`)

  const tag = text.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/)?.[1]
  if (!tag || !HTML_BLOCK_TAG.test(`${tag}${text.slice(text.indexOf(tag) + tag.length)}`)) {
    return null
  }

  let end = start
  while (end + 1 < lines.length && lines[end + 1].text.trim() !== '') end += 1
  return end
}

/**
 * Lossless block tokenization. Ranges point directly into the canonical
 * source; line endings are preserved in SourceDocument and normalized only
 * in the parser-facing RawLine.raw value.
 */
export function initialTokenizeWithRanges(content: string): SourceToken[] {
  const lines = splitPhysicalLines(content)
  const result: SourceToken[] = []
  let index = 0

  const pushRange = (startLine: number, endLine: number) => {
    const start = lines[startLine].start
    const end = lines[endLine].end
    const exactRaw = content.slice(start, end)
    result.push({
      id: uid(),
      raw: exactRaw.replace(/\r\n?|\n/g, '\n'),
      leading: lines[startLine].text.match(/^[ \t]*/)?.[0] ?? '',
      range: { from: start, to: end }
    })
  }

  while (index < lines.length) {
    const fence = matchCodeFence(lines[index].text)
    if (fence) {
      let end = index + 1
      let closed = false
      while (end < lines.length) {
        const closeFence = matchCodeFence(lines[end].text)
        if (
          closeFence &&
          closeFence.marker[0] === fence.marker[0] &&
          closeFence.marker.length === fence.marker.length &&
          closeFence.language === ''
        ) {
          closed = true
          break
        }
        end += 1
      }
      if (closed) {
        pushRange(index, end)
        index = end + 1
        continue
      }
    }

    if (lines[index].text.trim() === '$$') {
      let end = index + 1
      while (end < lines.length && lines[end].text.trim() !== '$$') end += 1
      if (end < lines.length) {
        pushRange(index, end)
        index = end + 1
        continue
      }
    }

    const htmlEnd = htmlBlockEnd(lines, index)
    if (htmlEnd !== null) {
      pushRange(index, htmlEnd)
      index = htmlEnd + 1
      continue
    }

    if (
      isTableRow(lines[index].text) &&
      index + 1 < lines.length &&
      isTableSeparator(lines[index + 1].text)
    ) {
      let end = index + 2
      while (end < lines.length && isTableRow(lines[end].text)) {
        if (end + 1 < lines.length && isTableSeparator(lines[end + 1].text)) break
        end += 1
      }
      pushRange(index, end - 1)
      index = end
      continue
    }

    pushRange(index, index)
    index += 1
  }

  return result
}

export function initialTokenize(content: string): RawLine[] {
  const raws = content.split('\n')
  const result: RawLine[] = []

  let i = 0
  while (i < raws.length) {
    const fence = matchCodeFence(raws[i])
    if (fence) {
      // 找到围栏代码块开启标记，搜索对应的关闭标记
      const openMarkerChar = fence.marker[0]
      const openMarkerLen = fence.marker.length
      const language = fence.language
      const codeLines: string[] = []
      let j = i + 1
      let closed = false

      while (j < raws.length) {
        const closeFence = matchCodeFence(raws[j])
        if (closeFence && closeFence.marker[0] === openMarkerChar && closeFence.marker.length === openMarkerLen && closeFence.language === '') {
          // 找到匹配的关闭标记
          closed = true
          j++
          break
        }
        codeLines.push(raws[j])
        j++
      }

      if (closed) {
        // 将整个围栏代码块合并为一个特殊的 RawLine
        // raw 格式：```language\ncode_line1\ncode_line2\n```
        const fullRaw = codeLines.length === 0
          ? raws[i] + '\n' + raws[j - 1]
          : raws[i] + '\n' + codeLines.join('\n') + '\n' + raws[j - 1]
        result.push({ id: uid(), raw: fullRaw, leading: '' })
        i = j
      } else {
        // 没有找到关闭标记，当作普通行处理
        result.push(tokenizeByLine(raws[i]))
        i++
      }
    } else if (raws[i].startsWith('$$') && raws[i].endsWith('$$') && raws[i].length > 4) {
      result.push(tokenizeByLine(raws[i]))
      i++
    } else if (raws[i].trim() === '$$') {
      // 检测到块级数学公式 $$...$$
      const mathLines: string[] = []
      let j = i + 1
      let closed = false

      while (j < raws.length) {
        if (raws[j].trim() === '$$') {
          closed = true
          j++
          break
        }
        mathLines.push(raws[j])
        j++
      }

      if (closed) {
        // 将整个数学公式块合并为一个 RawLine
        // raw 格式：$$\ntex_content\n$$
        const fullRaw = mathLines.length === 0
          ? '$$\n$$'
          : '$$\n' + mathLines.join('\n') + '\n$$'
        result.push({ id: uid(), raw: fullRaw, leading: '' })
        i = j
      } else {
        // 没有找到关闭标记，当作普通行处理
        result.push(tokenizeByLine(raws[i]))
        i++
      }
    } else if (
      isTableRow(raws[i]) &&
      i + 1 < raws.length && isTableSeparator(raws[i + 1])
    ) {
      // 检测到表格：表头行 + 分隔行 + 数据行...
      const tableLines: string[] = [raws[i], raws[i + 1]]
      let j = i + 2
      while (j < raws.length && isTableRow(raws[j])) {
        tableLines.push(raws[j])
        j++
      }
      // 将整个表格合并为一个 RawLine，行之间用 \n 连接
      const fullRaw = tableLines.join('\n')
      result.push({ id: uid(), raw: fullRaw, leading: '' })
      i = j
    } else {
      result.push(tokenizeByLine(raws[i]))
      i++
    }
  }

  return result
}
