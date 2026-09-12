import { RawLine, BlockModel, InlineModel, INLINE_FLAG, HeadingBlock, ListItemBlock, BlockquoteBlock, CodeBlock, TableBlock, FootnoteRefInline, FootnoteDefBlock, MathInline, MathBlock, InlineSlot, HTMLInline, HTMLBlock } from "../types";

const TAB_WIDTH = 4

function parseFencedCodeRaw(raw: string): { language: string; code: string; fence: string; codeLineCount: number } | null {
  const lines = raw.split('\n')
  if (lines.length < 2) return null

  const openMatch = lines[0].match(/^(`{3,}|~{3,})[ \t]*(.*)$/)
  if (!openMatch) return null

  const fence = openMatch[1]
  const closeLine = lines[lines.length - 1]
  const closeMatch = closeLine.match(/^(`{3,}|~{3,})[ \t]*$/)
  if (!closeMatch) return null
  if (closeMatch[1] !== fence) return null

  return {
    language: openMatch[2].trim(),
    code: lines.slice(1, -1).join('\n'),
    fence,
    codeLineCount: Math.max(0, lines.length - 2)
  }
}

function parseMathBlockRaw(raw: string): { tex: string; texLineCount: number; singleLine: boolean } | null {
  const mathLines = raw.split('\n')
  if (mathLines.length >= 2 && mathLines[0].trim() === '$$' && mathLines[mathLines.length - 1].trim() === '$$') {
    return {
      tex: mathLines.slice(1, -1).join('\n'),
      texLineCount: Math.max(0, mathLines.length - 2),
      singleLine: false
    }
  }

  return null
}

/**
 * 标记符 token，记录在原始文本中的位置和类型
 */
type MarkerToken = {
  pos: number       // 在原始文本中的起始位置
  len: number       // 标记符长度
  raw: string       // 标记符原始文本
  flag: number      // 对应的 INLINE_FLAG
  paired: boolean   // 是否已配对
  pairIndex: number // 配对的另一个 token 的索引（-1 表示未配对）
}

export function inlineParse(input: string): {
  inline: InlineModel[],
  offset: number
} {
  if (!input) return { inline: [], offset: 0 }

  // ========== 第一遍：扫描所有标记符位置 ==========
  const tokens: MarkerToken[] = []
  // 同时处理链接结构
  type LinkSpan = { start: number; closeBracket: number; openParen: number; closeParen: number; isImage?: boolean }
  const links: LinkSpan[] = []

  let i = 0
  while (i < input.length) {
    // 行内代码 ` — 特殊处理，代码块内不解析其他标记符
    if (input[i] === '`') {
      const end = input.indexOf('`', i + 1)
      if (end !== -1) {
        // 检查两个 ` 之间是否有文本内容
        if (end === i + 1) {
          // 紧邻的 ``，中间没有文本，当作普通字符
          i++
          continue
        }
        // 代码块作为一个已配对的 token 对
        const openIdx = tokens.length
        tokens.push({ pos: i, len: 1, raw: '`', flag: INLINE_FLAG.CODE, paired: true, pairIndex: openIdx + 1 })
        tokens.push({ pos: end, len: 1, raw: '`', flag: INLINE_FLAG.CODE, paired: true, pairIndex: openIdx })
        i = end + 1
        continue
      }
      // 没有匹配的 `，当作普通字符
      i++
      continue
    }

    // 图片 ![alt](url)
    if (input[i] === '!' && input[i + 1] === '[') {
      const closeBracket = input.indexOf(']', i + 2)
      if (closeBracket !== -1 && input[closeBracket + 1] === '(') {
        const closeParen = input.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          links.push({ start: i, closeBracket, openParen: closeBracket + 1, closeParen, isImage: true })
          i = closeParen + 1
          continue
        }
      }
      i++
      continue
    }

    // 链接 [text](url)
    if (input[i] === '[') {
      const closeBracket = input.indexOf(']', i + 1)
      if (closeBracket !== -1 && input[closeBracket + 1] === '(') {
        const closeParen = input.indexOf(')', closeBracket + 2)
        if (closeParen !== -1) {
          links.push({ start: i, closeBracket, openParen: closeBracket + 1, closeParen, isImage: false })
          i = closeParen + 1
          continue
        }
      }
      i++
      continue
    }

    // 删除线 ~~
    if (input[i] === '~' && input[i + 1] === '~') {
      tokens.push({ pos: i, len: 2, raw: '~~', flag: INLINE_FLAG.STRIKE, paired: false, pairIndex: -1 })
      i += 2
      continue
    }

    // 加粗 **（必须在单个 * 之前检查）
    if (input[i] === '*' && input[i + 1] === '*') {
      tokens.push({ pos: i, len: 2, raw: '**', flag: INLINE_FLAG.BOLD, paired: false, pairIndex: -1 })
      i += 2
      continue
    }

    // 高亮 ==
    if (input[i] === '=' && input[i + 1] === '=') {
      tokens.push({ pos: i, len: 2, raw: '==', flag: INLINE_FLAG.HIGHLIGHT, paired: false, pairIndex: -1 })
      i += 2
      continue
    }

    // 斜体 * 或 _
    if (input[i] === '*' || input[i] === '_') {
      tokens.push({ pos: i, len: 1, raw: input[i], flag: INLINE_FLAG.ITALIC, paired: false, pairIndex: -1 })
      i++
      continue
    }

    i++
  }

  // ========== 第二遍：从左到右两两配对（同类型标记符） ==========
  // 对每种标记符类型，维护一个"等待配对"的栈
  // 代码块已经在第一遍中配对了，跳过
  const waitingStack = new Map<number, number[]>() // flag -> token index stack

  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if (token.paired) continue // 已配对（如代码块）

    const stack = waitingStack.get(token.flag)
    if (stack && stack.length > 0) {
      // 有等待配对的同类型标记符
      // 检查两个标记符之间是否有文本内容
      const openIdx = stack[stack.length - 1]
      const openToken = tokens[openIdx]
      const openEnd = openToken.pos + openToken.len  // 开启标记符的结束位置
      const closeStart = token.pos                    // 关闭标记符的起始位置

      if (openEnd >= closeStart) {
        // 两个标记符之间没有任何文本（紧邻或重叠），不配对
        // 将当前 token 也入栈（替换掉之前的，因为之前的已经无法配对了）
        // 弹出旧的，两个都作为未配对
        stack.pop()
        // 不入栈当前 token，因为它也无法与后续配对形成有效结构
        // （两个紧邻的同类标记符都退化为纯文本）
        continue
      }

      // 中间有文本，正常配对
      stack.pop()
      tokens[openIdx].paired = true
      tokens[openIdx].pairIndex = t
      token.paired = true
      token.pairIndex = openIdx
    } else {
      // 没有等待配对的，入栈
      if (!waitingStack.has(token.flag)) {
        waitingStack.set(token.flag, [])
      }
      waitingStack.get(token.flag)!.push(t)
    }
  }

  // ========== 第三遍：根据配对结果生成 inline 段 ==========
  const result: InlineModel[] = []
  let logicalOffset = 0

  // 构建一个位置 → token 的映射，方便快速查找
  const tokenAtPos = new Map<number, { token: MarkerToken; index: number }>()
  for (let t = 0; t < tokens.length; t++) {
    tokenAtPos.set(tokens[t].pos, { token: tokens[t], index: t })
  }

  // 构建一个位置 → link 的映射
  const linkAtPos = new Map<number, LinkSpan>()
  for (const link of links) {
    linkAtPos.set(link.start, link)
  }

  // 当前活跃的格式标记（已配对的开启标记符）
  let currentMarks = 0
  // 自上次文本段结束后新出现的开启 marker。markers 必须描述相邻
  // inline 段之间的真实 raw 边界，不能把所有活跃 marker 包到每一段上，
  // 否则 **bold *italic*** 会在 round-trip 时重复输出外层 **。
  let pendingPrefix = ''

  let pos = 0
  let buffer = ''
  let bufferRawStart: number | null = null

  const flush = () => {
    if (!buffer) return

    const markers = currentMarks !== 0
      ? { prefix: pendingPrefix, suffix: '' }
      : undefined

    result.push({
      type: 'text',
      text: buffer,
      marks: currentMarks,
      offset: logicalOffset - buffer.length,
      rawStart: bufferRawStart ?? pos - buffer.length,
      rawEnd: pos,
      dirty: false,
      markers
    })
    buffer = ''
    bufferRawStart = null
    pendingPrefix = ''
  }

  while (pos < input.length) {
    // Raw inline HTML is preserved as a source projection and sanitized only
    // when rendered. This parser intentionally does not mutate the fragment.
    if (input[pos] === '<') {
      let end = -1
      if (input.startsWith('<!--', pos)) {
        const commentEnd = input.indexOf('-->', pos + 4)
        if (commentEnd !== -1) end = commentEnd + 2
      } else {
        const candidateEnd = input.indexOf('>', pos + 1)
        if (candidateEnd !== -1) {
          const candidate = input.slice(pos, candidateEnd + 1)
          if (
            /^<\/?[A-Za-z][^<>]*>$/.test(candidate) ||
            /^<\?.*\?>$/.test(candidate) ||
            /^<![A-Z][^<>]*>$/.test(candidate)
          ) {
            end = candidateEnd
          }
        }
      }
      if (end !== -1) {
        flush()
        const htmlRaw = input.slice(pos, end + 1)
        result.push({
          type: 'html-inline',
          raw: htmlRaw,
          marks: currentMarks,
          offset: logicalOffset,
          rawStart: pos,
          rawEnd: end + 1,
          dirty: false
        } as HTMLInline)
        logicalOffset += htmlRaw.length
        pos = end + 1
        continue
      }
    }

    // 行内数学公式 $...$（不含 $$）
    if (input[pos] === '$' && input[pos + 1] !== '$') {
      const end = input.indexOf('$', pos + 1)
      if (end !== -1 && end > pos + 1) {
        // 确保不是 $$ 的一部分
        if (input[end + 1] !== '$') {
          flush()
          const tex = input.slice(pos + 1, end)
          result.push({
            type: 'math',
            tex,
            marks: currentMarks,
            offset: logicalOffset,
            rawStart: pos + 1,
            rawEnd: end,
            dirty: false
          } as MathInline)
          logicalOffset += tex.length
          pos = end + 1
          continue
        }
      }
    }

    // 脚注引用 [^id]
    if (input[pos] === '[' && input[pos + 1] === '^') {
      const closeBracket = input.indexOf(']', pos + 2)
      if (closeBracket !== -1 && input[closeBracket + 1] !== '(') {
        // 确认是脚注引用（不是链接）
        const footnoteId = input.slice(pos + 2, closeBracket)
        if (footnoteId && /^[\w-]+$/.test(footnoteId)) {
          flush()
          result.push({
            type: 'footnote-ref',
            id: footnoteId,
            marks: currentMarks,
            offset: logicalOffset,
            rawStart: pos + 2,
            rawEnd: closeBracket,
            dirty: false
          } as FootnoteRefInline)
          logicalOffset += footnoteId.length
          pos = closeBracket + 1
          continue
        }
      }
    }

    // 检查是否是链接/图片起始
    const link = linkAtPos.get(pos)
    if (link) {
      flush()
      if (link.isImage) {
        // 图片 ![alt](src)
        const altText = input.slice(link.start + 2, link.closeBracket)
        const src = input.slice(link.openParen + 1, link.closeParen)

        result.push({
          type: 'image',
          alt: altText,
          src,
          marks: currentMarks,
          offset: logicalOffset,
          rawStart: link.start + 2,
          rawEnd: link.closeBracket,
          dirty: false
        })

        logicalOffset += altText.length
        pos = link.closeParen + 1
      } else {
        // 链接 [text](url)
        const linkTextRaw = input.slice(link.start + 1, link.closeBracket)
        const href = input.slice(link.openParen + 1, link.closeParen)
        const parseResult = inlineParse(linkTextRaw)

        result.push({
          type: 'link',
          children: parseResult.inline,
          href,
          marks: currentMarks,
          offset: logicalOffset,
          rawStart: link.start,
          rawEnd: link.closeParen + 1,
          dirty: false
        })

        logicalOffset += parseResult.offset
        pos = link.closeParen + 1
      }
      continue
    }

    // 检查是否是标记符位置
    const entry = tokenAtPos.get(pos)
    if (entry) {
      const { token } = entry

      if (token.paired) {
        // 已配对的标记符
        if (token.flag === INLINE_FLAG.CODE) {
          // 代码块：找到配对的关闭标记符
          const closeToken = tokens[token.pairIndex]
          if (closeToken.pos > token.pos) {
            // 这是开启标记符
            flush()
            const codeText = input.slice(token.pos + token.len, closeToken.pos)
            result.push({
              type: 'text',
              text: codeText,
              marks: INLINE_FLAG.CODE,
              offset: logicalOffset,
              rawStart: token.pos + token.len,
              rawEnd: closeToken.pos,
              dirty: false,
              markers: { prefix: '`', suffix: '`' }
            })
            logicalOffset += codeText.length
            pos = closeToken.pos + closeToken.len
            continue
          } else {
            // 这是关闭标记符（不应该单独遇到，跳过）
            pos += token.len
            continue
          }
        }

        // 非代码标记符
        const pairToken = tokens[token.pairIndex]
        if (pairToken.pos > token.pos) {
          // 这是开启标记符 → flush 当前 buffer，开启新格式
          flush()
          currentMarks |= token.flag
          pendingPrefix += token.raw
        } else {
          // 这是关闭标记符 → flush 当前 buffer，关闭格式
          flush()
          const previous = result[result.length - 1]
          if (previous?.type === 'text') {
            previous.markers ??= { prefix: '', suffix: '' }
            previous.markers.suffix += token.raw
          }
          currentMarks &= ~token.flag
        }
        pos += token.len
        continue
      } else {
        // 未配对的标记符 → 当作普通文本
        if (bufferRawStart === null) bufferRawStart = pos
        buffer += token.raw
        pos += token.len
        logicalOffset += token.raw.length
        continue
      }
    }

    // 普通字符
    if (bufferRawStart === null) bufferRawStart = pos
    buffer += input[pos]
    pos++
    logicalOffset++
  }

  flush()
  return { inline: result, offset: logicalOffset }
}


const leadingSpaceParse = (leading: string): number => {
  let depth = 0
  for (const char of leading) { 
    if (char === '\t') { 
      depth += TAB_WIDTH; 
    } else {
      depth += 1; 
    } 
  }
  return depth
}

function parseTableRowWithSlots(row: string, baseOffset: number): InlineSlot[] | null {
  const first = row.search(/\S/)
  if (first === -1) return null
  let last = row.length
  while (last > first && /\s/.test(row[last - 1])) last -= 1

  const segments: { from: number; to: number }[] = []
  let start = first
  let escaped = false
  let separators = 0

  for (let index = first; index < last; index += 1) {
    const char = row[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '|') {
      segments.push({ from: start, to: index })
      start = index + 1
      separators += 1
    }
  }
  segments.push({ from: start, to: last })
  if (separators === 0) return null

  if (row[first] === '|') segments.shift()
  if (row[last - 1] === '|') segments.pop()

  return segments.map(segment => {
    let from = segment.from
    let to = segment.to
    while (from < to && /\s/.test(row[from])) from += 1
    while (to > from && /\s/.test(row[to - 1])) to -= 1
    const raw = row.slice(from, to)
    const displayRaw = raw.replace(/\\\|/g, '|')
    return {
      raw,
      range: { from: baseOffset + from, to: baseOffset + to },
      inlines: inlineParse(displayRaw).inline
    }
  })
}

export function parseLine(line: RawLine): BlockModel {
  const { raw, leading } = line

  // 如果是空行
  if (raw.trim() === '')
    return {
      id: line.id,
      type: 'blank',
      inline: []
    }

  // 如果是水平线：---、***、___（至少 3 个相同字符，可以有空格）
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(raw.trim()))
    return {
      id: line.id,
      type: 'hr',
      inline: []
    }

  // 如果是围栏代码块（由 tokenize 阶段合并的多行 token）
  const codeBlockMatch = parseFencedCodeRaw(raw)
  if (codeBlockMatch) {
    return {
      id: line.id,
      type: 'code-block',
      language: codeBlockMatch.language,
      code: codeBlockMatch.code,
      fence: codeBlockMatch.fence,
      codeLineCount: codeBlockMatch.codeLineCount,
      inline: []
    } as CodeBlock
  }

  // 如果是块级数学公式（由 tokenize 阶段合并的多行 token，或整行 $$...$$）
  const mathBlockMatch = parseMathBlockRaw(raw)
  if (mathBlockMatch) {
    return {
      id: line.id,
      type: 'math-block',
      tex: mathBlockMatch.tex,
      texLineCount: mathBlockMatch.texLineCount,
      singleLine: mathBlockMatch.singleLine,
      inline: []
    } as MathBlock
  }

  const htmlStart = raw.trimStart()
  const htmlBlockTag = htmlStart.match(/^<\/?([A-Za-z][A-Za-z0-9-]*)/)?.[1]?.toLowerCase()
  const isHTMLBlock = (
    htmlStart.startsWith('<!--') ||
    htmlStart.startsWith('<?') ||
    htmlStart.startsWith('<![CDATA[') ||
    /^<![A-Z]/.test(htmlStart) ||
    ['script', 'pre', 'style', 'textarea', 'address', 'article', 'aside', 'base', 'basefont',
      'blockquote', 'body', 'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog',
      'dir', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame',
      'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe',
      'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol', 'optgroup',
      'option', 'p', 'param', 'search', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot',
      'th', 'thead', 'title', 'tr', 'track', 'ul'].includes(htmlBlockTag ?? '')
  )
  if (isHTMLBlock) {
    return {
      id: line.id,
      type: 'html-block',
      raw,
      inline: []
    } as HTMLBlock
  }

  // 如果是表格（由 tokenize 阶段合并的多行 token）
  const tableLines = raw.split('\n')
  const lineOffsets: number[] = []
  let tableOffset = 0
  tableLines.forEach(lineText => {
    lineOffsets.push(tableOffset)
    tableOffset += lineText.length + 1
  })
  const headerSlots = tableLines.length >= 2 ? parseTableRowWithSlots(tableLines[0], lineOffsets[0]) : null
  const separatorSlots = tableLines.length >= 2 ? parseTableRowWithSlots(tableLines[1], lineOffsets[1]) : null
  const validSeparator = separatorSlots?.every(slot => /^:?-{3,}:?$/.test(slot.raw.trim())) ?? false
  if (
    headerSlots &&
    separatorSlots &&
    headerSlots.length > 0 &&
    headerSlots.length === separatorSlots.length &&
    validSeparator
  ) {
    const headers = headerSlots.map(slot => slot.raw.replace(/\\\|/g, '|'))
    const aligns: ('left' | 'center' | 'right' | 'default')[] = separatorSlots.map(slot => {
      const cell = slot.raw.trim()
      const left = cell.startsWith(':')
      const right = cell.endsWith(':')
      if (left && right) return 'center'
      if (right) return 'right'
      if (left) return 'left'
      return 'default'
    })

    const rows: string[][] = []
    const rowSlots: InlineSlot[][] = []
    for (let r = 2; r < tableLines.length; r++) {
      const parsedSlots = parseTableRowWithSlots(tableLines[r], lineOffsets[r]) ?? []
      const normalizedSlots = Array.from({ length: headers.length }, (_, index) =>
        parsedSlots[index] ?? {
          raw: '',
          range: { from: lineOffsets[r] + tableLines[r].length, to: lineOffsets[r] + tableLines[r].length },
          inlines: []
        }
      )
      rowSlots.push(normalizedSlots)
      rows.push(normalizedSlots.map(slot => slot.raw.replace(/\\\|/g, '|')))
    }

    return {
      id: line.id,
      type: 'table',
      headers,
      aligns,
      rows,
      headerSlots,
      rowSlots,
      inline: []
    } as TableBlock
  }

  // 如果是脚注定义行 [^id]: content
  const footnoteDefMatch = raw.match(/^\[\^([\w-]+)\]:(\s*)(.*)$/)
  if (footnoteDefMatch) {
    const footnoteId = footnoteDefMatch[1]
    const footnoteSpacing = footnoteDefMatch[2]
    const content = footnoteDefMatch[3]
    const result: FootnoteDefBlock = {
      id: line.id,
      type: 'paragraph',
      footnoteId,
      footnoteSpacing,
      inline: inlineParse(content).inline,
    }
    return result
  }

  // 如果是引用
  if (/^(>+)(\s?)(.*)$/.test(raw)) {
    const match = raw.match(/^(>+)(\s?)(.*)$/)!
    const depth = match[1].length
    const spacing = match[2]
    const content = match[3]
    return {
      id: line.id,
      type: 'blockquote',
      quoteDepth: depth,
      quoteSpacing: spacing,
      inline: inlineParse(content).inline,
    } as BlockquoteBlock
  }
  
  // 如果是列表项
  if (/^\s*[-*+]\s/.test(raw)) {
    const match = raw.match(/^\s*[-*+]\s/)!
    const bullet = match[0].trim() as '-' | '*' | '+'
    const afterMarker = raw.slice(match[0].length)

    // 检测任务列表：- [ ] 或 - [x] 或 - [X]
    const taskMatch = afterMarker.match(/^\[([ xX])\](\s?)/)
    if (taskMatch) {
      const checked = taskMatch[1] !== ' '
      const checkedMarker = checked ? taskMatch[1] as 'x' | 'X' : undefined
      const content = afterMarker.slice(taskMatch[0].length)
      return {
        id: line.id,
        type: 'list-item',
        nesting: leadingSpaceParse(leading),
        inline: inlineParse(content).inline,
        style: {
          ordered: false,
          bullet,
          task: true,
          checked,
          checkedMarker,
          markerSpacing: taskMatch[2]
        }
      } as ListItemBlock
    }

    const content = afterMarker

    return {
      id: line.id,
      type: 'list-item',
      nesting: leadingSpaceParse(leading),
      inline: inlineParse(content).inline,
      style: {
        ordered: false,
        bullet
      }
    } as ListItemBlock
  }

  // 如果是有序列表
  if (/^(\s*)(\d+)\.\s/.test(raw)) {
    const match = raw.match(/^(\s*)(\d+)\.\s/)!
    // match[0] 包含前导空白 + 数字 + 点 + 空格
    // match[1] 是前导空白, match[2] 是数字
    // order 只保留 "数字. " 部分（不含前导空白，前导空白由 nesting 处理）
    const order = match[2] + '. '
    const content = raw.slice(match[0].length)

    return {
      id: line.id,
      type: 'list-item',
      nesting: leadingSpaceParse(leading),
      inline: inlineParse(content).inline,
      style: {
        ordered: true,
        order
      } 
    } as ListItemBlock
  }

  if (/^(#{1,6}) (.*)$/.test(raw)) {
    const match = raw.match(/^(#{1,6}) (.*)$/)!
    // 注意 heading 不缩进，这里直接复用 depth 作为标题层级
    const depth = match[1].length
    const content = match[2]
    return {
      id: line.id,
      type: 'heading',
      headingDepth: depth,
      inline: inlineParse(content).inline,
    } as HeadingBlock
  }

  return {
    id: line.id,
    type: 'paragraph',
    nesting: leadingSpaceParse(leading),
    inline: inlineParse(raw.slice(leading.length)).inline,
  }
}
