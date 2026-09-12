
import { BlockModel, InlineModel, ListItemBlock, HeadingBlock, BlockquoteBlock, CodeBlock, TableBlock, TextInline, INLINE_FLAG, MathBlock, FootnoteDefBlock, FootnoteRefInline, MathInline } from "../types"
import { parseLine, inlineParse } from "./parse"
import { initialTokenize, initialTokenizeWithRanges, tokenizeByLine, uid } from "./tokenize"
import { BlockMatchResult, matchListItem, matchHeading } from "./matcher"
import {
  SourceDocument,
  type AppliedEditTransaction,
  type EditOrigin,
  type EditTransaction,
  type SourceRange
} from "./SourceDocument"
import { coreBlockSpecs, type BlockProjection } from "./BlockSpec"

function parseFencedCodeRaw(rawText: string): { language: string; code: string; fence: string; codeLineCount: number } | null {
  const lines = rawText.split('\n')
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

function parseMathBlockRaw(rawText: string): { tex: string; texLineCount: number; singleLine: boolean } | null {
  const mathLines = rawText.split('\n')
  if (mathLines.length >= 2 && mathLines[0].trim() === '$$' && mathLines[mathLines.length - 1].trim() === '$$') {
    return {
      tex: mathLines.slice(1, -1).join('\n'),
      texLineCount: Math.max(0, mathLines.length - 2),
      singleLine: false
    }
  }

  return null
}

function toCsvCell(value: string): string {
  if (!/[",\r\n]/.test(value)) return value
  return `"${value.replace(/"/g, '""')}"`
}

export class DocumentController {
  blocks = new Map<string, BlockModel>()
  private sourceDocument: SourceDocument
  private blockRanges = new Map<string, SourceRange>()
  private lastParseStats = { totalBlocks: 0, parsedBlocks: 0 }
  
  constructor(content: string) {
    this.sourceDocument = new SourceDocument(content)
    this.rebuildFromSource()
  }
  
  getBlocks = () => this.blocks
  getBlock = (id: string) => this.blocks.get(id)
  getBlockSpec = (id: string) => {
    const block = this.blocks.get(id)
    return block ? coreBlockSpecs.get(block.type) : null
  }
  getBlockProjection = (id: string): BlockProjection | null => {
    const model = this.blocks.get(id)
    const range = this.blockRanges.get(id)
    if (!model || !range) return null
    const table = model.type === 'table' ? model as TableBlock : null
    return {
      id,
      range,
      raw: this.sourceDocument.slice(range),
      model,
      slots: table
        ? [...(table.headerSlots ?? []), ...(table.rowSlots ?? []).flat()]
        : []
    }
  }
  getSource = () => this.sourceDocument.source
  getSourceRange = (id: string): SourceRange | null => this.blockRanges.get(id) ?? null
  getSourceOffset = (id: string, localOffset: number): number | null => {
    const range = this.blockRanges.get(id)
    if (!range || localOffset < 0 || localOffset > range.to - range.from) return null
    return range.from + localOffset
  }
  resolveSourceOffset(offset: number): { blockId: string; localOffset: number } | null {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.sourceDocument.source.length) return null
    const entries = Array.from(this.blockRanges.entries())
    for (let index = 0; index < entries.length; index += 1) {
      const [blockId, range] = entries[index]
      if (offset >= range.from && offset <= range.to) {
        return { blockId, localOffset: offset - range.from }
      }
      if (offset < range.from) {
        const previous = entries[index - 1]
        return previous
          ? { blockId: previous[0], localOffset: previous[1].to - previous[1].from }
          : { blockId, localOffset: 0 }
      }
    }
    const last = entries[entries.length - 1]
    return last
      ? { blockId: last[0], localOffset: last[1].to - last[1].from }
      : null
  }
  getParseStats = () => ({ ...this.lastParseStats })
  getRawTextForBlockRange(
    startBlockId: string,
    endBlockId: string,
    overrides: ReadonlyMap<string, string> = new Map()
  ): string | null {
    const ids = Array.from(this.blocks.keys())
    const startIndex = ids.indexOf(startBlockId)
    const endIndex = ids.indexOf(endBlockId)
    if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) return null

    let result = ''
    for (let index = startIndex; index <= endIndex; index += 1) {
      const id = ids[index]
      const range = this.blockRanges.get(id)
      if (!range) return null
      result += overrides.get(id) ?? this.sourceDocument.slice(range)

      if (index < endIndex) {
        const nextRange = this.blockRanges.get(ids[index + 1])
        if (!nextRange) return null
        result += this.sourceDocument.source.slice(range.to, nextRange.from)
      }
    }
    return result
  }

  getRawOffsetWithinBlockRange(startBlockId: string, blockId: string, localOffset: number): number | null {
    const startRange = this.blockRanges.get(startBlockId)
    const blockRange = this.blockRanges.get(blockId)
    if (!startRange || !blockRange || blockRange.from < startRange.from) return null
    return blockRange.from - startRange.from + localOffset
  }
  getHistoryState = () => ({
    source: this.sourceDocument.source,
    blockIds: Array.from(this.blocks.keys())
  })

  applyHistoryTransaction(transaction: EditTransaction, blockIds: string[]): void {
    this.applyTransaction(transaction)
    this.rebindBlockIdsInOrder(blockIds)
  }

  applyTransaction(transaction: EditTransaction, preferredBlockId?: string): AppliedEditTransaction {
    const previous = Array.from(this.blocks, ([id, model]) => ({
      id,
      model,
      range: this.blockRanges.get(id)
    })).filter((entry): entry is { id: string; model: BlockModel; range: SourceRange } => Boolean(entry.range))

    const applied = this.sourceDocument.apply(transaction)
    this.rebuildFromSource(previous, transaction, preferredBlockId)
    return applied
  }

  private rebuildFromSource(
    previous: { id: string; model: BlockModel; range: SourceRange }[] = [],
    transaction?: EditTransaction,
    preferredBlockId?: string
  ): void {
    const tokens = initialTokenizeWithRanges(this.sourceDocument.source)
    const mappedIds = new Map<string, string>()
    const previousModels = new Map(previous.map(entry => [entry.id, entry.model]))

    if (transaction) {
      for (const entry of previous) {
        // An explicitly edited empty block owns its insertion point. Mapping
        // it to the right would give a newly split second line the old ID.
        if (entry.id === preferredBlockId && entry.range.from === entry.range.to) continue
        const mapped = mapUnaffectedRange(entry.range, transaction)
        if (mapped) mappedIds.set(rangeKey(mapped), entry.id)
      }
    }

    const nextBlocks = new Map<string, BlockModel>()
    const nextRanges = new Map<string, SourceRange>()
    const tokenRangeKeys = new Set(tokens.map(token => rangeKey(token.range)))
    const idsWithReusableMappedRange = new Set(
      Array.from(mappedIds)
        .filter(([key]) => tokenRangeKeys.has(key))
        .map(([, id]) => id)
    )
    const assignedIds = new Set<string>()
    let preferredAssigned = false
    let parsedBlocks = 0
    const changedStart = transaction?.changes.reduce(
      (minimum, change) => Math.min(minimum, change.range.from),
      Number.POSITIVE_INFINITY
    )

    const preferred = previous.find(entry => entry.id === preferredBlockId)
    for (const token of tokens) {
      let id = mappedIds.get(rangeKey(token.range))
      if (preferred && preferred.range.from === token.range.from && !assignedIds.has(preferred.id)) {
        id = preferred.id
      }
      if (id && assignedIds.has(id)) id = undefined

      // A changed projection may absorb earlier blocks (for example, typing a
      // table separator turns the header + current line into one table).
      // Preserve the earliest absorbed block ID. Requiring the old range start
      // to equal the new range start also gives split operations their contract:
      // only the first child reuses the original ID.
      if (!id) {
        id = previous.find(entry =>
          entry.range.from === token.range.from &&
          !assignedIds.has(entry.id) &&
          !idsWithReusableMappedRange.has(entry.id)
        )?.id
      }

      if (!id && preferredBlockId && !preferredAssigned && !assignedIds.has(preferredBlockId)) {
        const containsChange = changedStart === undefined ||
          changedStart === Number.POSITIVE_INFINITY ||
          (token.range.from <= changedStart && token.range.to >= changedStart)
        if (containsChange) {
          id = preferredBlockId
          preferredAssigned = true
        }
      }
      if (!id) id = token.id
      assignedIds.add(id)

      const reused = mappedIds.get(rangeKey(token.range)) === id
        ? previousModels.get(id)
        : undefined
      const parsed = reused ?? parseLine({ ...token, id })
      if (!reused) parsedBlocks += 1
      nextBlocks.set(id, parsed)
      nextRanges.set(id, token.range)
    }

    this.blocks = nextBlocks
    this.blockRanges = nextRanges
    this.lastParseStats = { totalBlocks: tokens.length, parsedBlocks }
  }

  updateBlock = (id: string, line: string): BlockModel => {
    this.reconcileFromRawText(id, line, 'api')
    return this.blocks.get(id)!
  }

  insertBlockAfter = (blockId: string, block: BlockModel) => {
    const raw = this.inlineToRawText(block.inline ?? [])
    this.createBlockFromRawText(raw, blockId)
  }

  /**
   * 从 block model 重建整行原始 Markdown 文本（包含标识符）
   * 例如 list-item: "- **bold**text" / heading: "## title"
   */
  getRawText(blockId: string): string {
    const range = this.blockRanges.get(blockId)
    return range ? this.sourceDocument.slice(range) : ''
  }

  getCodeBlockContent(blockId: string): string | null {
    const block = this.blocks.get(blockId)
    if (!block || block.type !== 'code-block') return null
    return (block as CodeBlock).code
  }

  getMathBlockContent(blockId: string): string | null {
    const block = this.blocks.get(blockId)
    if (!block || block.type !== 'math-block') return null
    return (block as MathBlock).tex
  }

  getTableCsv(blockId: string): string | null {
    const block = this.blocks.get(blockId)
    if (!block || block.type !== 'table') return null

    const table = block as TableBlock
    const rows = [table.headers, ...table.rows]
    return rows
      .map(row => table.headers.map((_, index) => toCsvCell(row[index] ?? '')).join(','))
      .join('\n')
  }

  getTableRowCsv(blockId: string, rowIndex: number): string | null {
    const block = this.blocks.get(blockId)
    if (!block || block.type !== 'table') return null
    if (!Number.isInteger(rowIndex)) return null

    const table = block as TableBlock
    if (rowIndex < 0 || rowIndex >= table.rows.length) return null

    const row = table.rows[rowIndex]
    return table.headers.map((_, index) => toCsvCell(row[index] ?? '')).join(',')
  }

  getTableColumnCsv(blockId: string, columnIndex: number): string | null {
    const block = this.blocks.get(blockId)
    if (!block || block.type !== 'table') return null
    if (!Number.isInteger(columnIndex)) return null

    const table = block as TableBlock
    if (columnIndex < 0 || columnIndex >= table.headers.length) return null

    return [table.headers, ...table.rows]
      .map(row => toCsvCell(row[columnIndex] ?? ''))
      .join('\n')
  }

  /**
   * 将 inline model 数组重建为原始 Markdown 文本（包含标记符如 **、~~、== 等）
   */
  inlineToRawText(inlines: InlineModel[]): string {
    let result = ''
    for (const inline of inlines) {
      if (inline.type === 'text') {
        if (inline.markers && inline.marks !== 0) {
          result += inline.markers.prefix + inline.text + inline.markers.suffix
        } else {
          result += inline.text
        }
      } else if (inline.type === 'link') {
        const linkText = this.inlineToRawText(inline.children)
        result += `[${linkText}](${inline.href})`
      } else if (inline.type === 'image') {
        result += `![${inline.alt}](${inline.src})`
      } else if (inline.type === 'footnote-ref') {
        result += `[^${(inline as FootnoteRefInline).id}]`
      } else if (inline.type === 'math') {
        result += `$${(inline as MathInline).tex}$`
      } else if (inline.type === 'html-inline') {
        result += inline.raw
      }
    }
    return result
  }

  /**
   * 从修改后的原始文本进行全行 reconcile
   * 用于标识符内部输入的场景
   */
  reconcileFromRawText(blockId: string, newRawText: string, origin: EditOrigin = 'keyboard'):
    { kind: 'inline-update'; block: BlockModel } | 
    { kind: 'block-transform'; from: BlockModel; to: BlockModel } | 
    { kind: 'code-block-degrade'; from: BlockModel; lines: BlockModel[] } |
    null {
    const before = this.blocks.get(blockId)
    const range = this.blockRanges.get(blockId)
    if (!before || !range) return null

    const previousIds = new Set(this.blocks.keys())
    this.applyTransaction({
      changes: [{ range, insert: newRawText }],
      origin
    }, blockId)

    const after = this.blocks.get(blockId) ?? Array.from(this.blocks.entries())
      .find(([, candidate]) => {
        const candidateRange = this.blockRanges.get(candidate.id)
        return Boolean(candidateRange && candidateRange.from <= range.from && candidateRange.to >= range.from)
      })?.[1]
    if (!after) return null

    const addedBlocks = Array.from(this.blocks.values()).filter(block => !previousIds.has(block.id))
    if (addedBlocks.length > 0) {
      return { kind: 'code-block-degrade', from: before, lines: [after, ...addedBlocks] }
    }
    if (
      (before.type === 'code-block' || before.type === 'math-block' || before.type === 'table') &&
      after.type !== before.type
    ) {
      return { kind: 'code-block-degrade', from: before, lines: [after] }
    }

    if (!isSameBlockShape(before, after)) {
      return { kind: 'block-transform', from: before, to: after }
    }
    return { kind: 'inline-update', block: after }
  }

  reconcileBlock(id: string, domText: string) {
    const block = this.blocks.get(id)
    if (!block) return null
    return this.reconcileFromRawText(id, domText)
  }

  transformListItemToParagraph(block: BlockModel): BlockModel {
    return {
      id: block.id,
      type: 'paragraph',
      nesting: block.nesting,
      inline: block.inline ?? [],
    }
  }

  /**
   * 获取指定 block 的前一个 block ID（按文档顺序）
   * 如果已经是第一个 block 则返回 null
   */
  getPreviousBlockId(blockId: string): string | null {
    const ids = Array.from(this.blocks.keys())
    const idx = ids.indexOf(blockId)
    if (idx <= 0) return null
    return ids[idx - 1]
  }

  getNextBlockId(blockId: string): string | null {
    const ids = Array.from(this.blocks.keys())
    const idx = ids.indexOf(blockId)
    if (idx === -1 || idx >= ids.length - 1) return null
    return ids[idx + 1]
  }

  moveBlock(blockId: string, direction: 'up' | 'down'): boolean {
    const entries = Array.from(this.blocks.entries())
    const idx = entries.findIndex(([id]) => id === blockId)
    if (idx === -1) return false

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1
    if (targetIdx < 0 || targetIdx >= entries.length) return false

    const firstIdx = Math.min(idx, targetIdx)
    const secondIdx = Math.max(idx, targetIdx)
    const firstId = entries[firstIdx][0]
    const secondId = entries[secondIdx][0]
    const firstRange = this.blockRanges.get(firstId)
    const secondRange = this.blockRanges.get(secondId)
    if (!firstRange || !secondRange) return false

    const separator = this.sourceDocument.source.slice(firstRange.to, secondRange.from)
    const firstRaw = this.getRawText(firstId)
    const secondRaw = this.getRawText(secondId)
    this.applyTransaction({
      changes: [{
        range: { from: firstRange.from, to: secondRange.to },
        insert: secondRaw + separator + firstRaw
      }],
      origin: 'command'
    })

    // A move changes source positions, but the block identities travel with
    // their content. Rebind both projections explicitly instead of letting the
    // generic split/merge lineage rule assign IDs by source position.
    const nextEntries = Array.from(this.blocks.entries())
    const firstMoved = nextEntries[firstIdx]
    const secondMoved = nextEntries[secondIdx]
    if (!firstMoved || !secondMoved) return false

    const desiredIds = nextEntries.map(([id]) => id)
    desiredIds[firstIdx] = secondId
    desiredIds[secondIdx] = firstId
    this.rebindBlockIdsInOrder(desiredIds)
    return true
  }

  deleteBlock(blockId: string): { deletedBlockId: string; focusBlockId: string } | null {
    const entries = Array.from(this.blocks.entries())
    const idx = entries.findIndex(([id]) => id === blockId)
    if (idx === -1) return null

    if (entries.length === 1) {
      this.reconcileFromRawText(blockId, '', 'command')
      return { deletedBlockId: blockId, focusBlockId: blockId }
    }

    const focusEntry = entries[idx + 1] ?? entries[idx - 1]
    const range = this.blockRanges.get(blockId)
    if (!range) return null
    const deleteRange = idx < entries.length - 1
      ? { from: range.from, to: this.blockRanges.get(entries[idx + 1][0])!.from }
      : { from: this.blockRanges.get(entries[idx - 1][0])!.to, to: range.to }
    this.applyTransaction({
      changes: [{ range: deleteRange, insert: '' }],
      origin: 'command'
    })
    return { deletedBlockId: blockId, focusBlockId: focusEntry[0] }
  }

  /**
   * 将当前 block 的内容合并到前一个 block 末尾，然后删除当前 block
   * 返回合并后的 block 和光标应该定位的语义偏移量
   * 
   * 合并策略：
   * - 将当前 block 的原始文本（不含结构前缀）追加到前一个 block 的原始文本末尾
   * - 用 reconcileFromRawText 重新解析前一个 block
   * - 删除当前 block
   */
  mergeBlockWithPrevious(blockId: string): {
    mergedBlock: BlockModel
    cursorRawOffset: number
    removedBlockId: string
  } | null {
    const prevId = this.getPreviousBlockId(blockId)
    if (!prevId) return null

    const currentBlock = this.blocks.get(blockId)
    const prevBlock = this.blocks.get(prevId)
    if (!currentBlock || !prevBlock) return null

    // 获取前一个 block 的原始文本
    const prevRawText = this.getRawText(prevId)
    // 光标应该定位在前一个 block 原始文本的末尾
    const cursorRawOffset = prevRawText.length

    // 获取当前 block 的完整原始文本（包含结构前缀如 ##、- 等）
    // 因为在 markdown 源码中，这些标识符是真实存在的文本
    const currentRawText = this.getRawText(blockId)

    // 合并后的文本 = 前一个 block 原始文本 + 当前 block 完整原始文本
    const mergedRawText = prevRawText + currentRawText

    const prevRange = this.blockRanges.get(prevId)
    const currentRange = this.blockRanges.get(blockId)
    if (!prevRange || !currentRange) return null
    const previousIds = new Set(this.blocks.keys())
    const effect = this.replaceSourceRange(
      { from: prevRange.from, to: currentRange.to },
      mergedRawText,
      'keyboard',
      prevId,
      prevBlock
    )
    if (!effect) return null
    if (effect.kind === 'code-block-degrade') return null

    const mergedBlock = effect.kind === 'block-transform' ? effect.to : effect.block
    if (previousIds.has(blockId) && this.blocks.has(blockId)) return null

    return {
      mergedBlock,
      cursorRawOffset,
      removedBlockId: blockId
    }
  }

  mergeBlockWithNext(blockId: string): {
    mergedBlock: BlockModel
    cursorRawOffset: number
    removedBlockId: string
  } | null {
    const nextId = this.getNextBlockId(blockId)
    if (!nextId) return null

    const block = this.blocks.get(blockId)
    const nextBlock = this.blocks.get(nextId)
    if (!block || !nextBlock) return null

    const currentRawText = this.getRawText(blockId)
    const nextRawText = this.getRawText(nextId)
    const cursorRawOffset = currentRawText.length
    const mergedRawText = currentRawText + nextRawText

    const currentRange = this.blockRanges.get(blockId)
    const nextRange = this.blockRanges.get(nextId)
    if (!currentRange || !nextRange) return null
    const effect = this.replaceSourceRange(
      { from: currentRange.from, to: nextRange.to },
      mergedRawText,
      'keyboard',
      blockId,
      block
    )
    if (!effect || effect.kind === 'code-block-degrade') return null

    const mergedBlock = effect.kind === 'block-transform' ? effect.to : effect.block

    return {
      mergedBlock,
      cursorRawOffset,
      removedBlockId: nextId
    }
  }

  replaceBlockRangeFromRawText(startBlockId: string, endBlockId: string, rawText: string): {
    blocks: BlockModel[]
    removedBlockIds: string[]
  } | null {
    const ids = Array.from(this.blocks.keys())
    const startIdx = ids.indexOf(startBlockId)
    const endIdx = ids.indexOf(endBlockId)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) return null

    const startRange = this.blockRanges.get(startBlockId)
    const endRange = this.blockRanges.get(endBlockId)
    if (!startRange || !endRange) return null
    const removedBlockIds = ids.slice(startIdx + 1, endIdx + 1)
    this.applyTransaction({
      changes: [{
        range: { from: startRange.from, to: endRange.to },
        insert: rawText
      }],
      origin: 'command'
    }, startBlockId)
    const insertedEnd = startRange.from + rawText.length
    const newBlocks = Array.from(this.blocks, ([id, block]) => ({
      block,
      range: this.blockRanges.get(id)
    }))
      .filter((entry): entry is { block: BlockModel; range: SourceRange } => Boolean(entry.range))
      .filter(entry =>
        entry.range.from >= startRange.from &&
        entry.range.to <= insertedEnd
      )
      .map(entry => entry.block)
    return { blocks: newBlocks, removedBlockIds }
  }

  parseBlocksFromRawText(rawText: string, firstBlockId?: string): BlockModel[] {
    const tokens = initialTokenize(rawText)
    if (tokens.length === 0) return []
    if (firstBlockId) tokens[0].id = firstBlockId
    return tokens.map(token => parseLine(token))
  }

  private replaceSourceRange(
    range: SourceRange,
    rawText: string,
    origin: EditOrigin,
    preferredBlockId: string,
    before: BlockModel
  ):
    { kind: 'inline-update'; block: BlockModel } |
    { kind: 'block-transform'; from: BlockModel; to: BlockModel } |
    { kind: 'code-block-degrade'; from: BlockModel; lines: BlockModel[] } |
    null {
    const previousIds = new Set(this.blocks.keys())
    this.applyTransaction({
      changes: [{ range, insert: rawText }],
      origin
    }, preferredBlockId)

    const after = this.blocks.get(preferredBlockId)
    if (!after) return null
    const added = Array.from(this.blocks.values()).filter(block => !previousIds.has(block.id))
    if (added.length > 0) return { kind: 'code-block-degrade', from: before, lines: [after, ...added] }
    if (!isSameBlockShape(before, after)) return { kind: 'block-transform', from: before, to: after }
    return { kind: 'inline-update', block: after }
  }

  prefixOffset = (BlockId: string) => {
    const block = this.blocks.get(BlockId)
    if (!block || !block.inline) return 0

    // let currentOffset = 0
    let prefixOffset = 0

    if (block.nesting) {
      // 每个 fullLevel indent = 4 个空格字符，remainder = 对应数量的空格字符
      // 总偏移 = nesting（即空格总数）
      prefixOffset += block.nesting
    }

    if (block.type === 'list-item') {
      const listItem = block as ListItemBlock
      if (listItem.style.ordered) {
        prefixOffset += listItem.style.order.length
      } else if ('task' in listItem.style && listItem.style.task) {
        prefixOffset += 5 + (listItem.style.markerSpacing ?? ' ').length
      } else {
        prefixOffset += 2
      }
    }

    if (block.type === 'heading') {
      const heading = block as HeadingBlock
      // heading marker: n 个 # + 1 个空格
      prefixOffset += heading.headingDepth + 1
    }

    if (block.type === 'blockquote') {
      const bq = block as BlockquoteBlock
      prefixOffset += bq.quoteDepth + (bq.quoteSpacing ?? ' ').length
    }

    return prefixOffset
  }

  /**
   * 从原始 Markdown 文本创建一个新 block 并注册到文档中
   * 确保新 block 插入到 afterBlockId 指定的 block 之后（Map 顺序）
   * 用于展开模式下的换行操作
   */
  createBlockFromRawText(rawText: string, afterBlockId?: string): BlockModel {
    const idsBefore = new Set(this.blocks.keys())
    const newline = preferredLineEnding(this.sourceDocument.source)
    const offset = afterBlockId
      ? this.blockRanges.get(afterBlockId)?.to
      : this.sourceDocument.source.length
    if (offset === undefined) throw new Error(`Unknown block: ${afterBlockId}`)

    this.applyTransaction({
      changes: [{ range: { from: offset, to: offset }, insert: newline + rawText }],
      origin: 'command'
    }, afterBlockId)

    const block = Array.from(this.blocks.values()).find(candidate => !idsBefore.has(candidate.id))
    if (!block) throw new Error('Failed to create block projection')
    return block
  }

  createBlockFromRawTextBefore(rawText: string, beforeBlockId: string): BlockModel | null {
    const range = this.blockRanges.get(beforeBlockId)
    if (!range) return null
    const idsBefore = new Set(this.blocks.keys())
    const newline = preferredLineEnding(this.sourceDocument.source)
    this.applyTransaction({
      changes: [{ range: { from: range.from, to: range.from }, insert: rawText + newline }],
      origin: 'command'
    })
    return Array.from(this.blocks.values()).find(candidate => !idsBefore.has(candidate.id)) ?? null
  }

  recoveryOffset = (BlockId: string, offset: number) => {
    const block = this.blocks.get(BlockId)
    if (!block || !block.inline) return

    // let currentOffset = 0
    const prefixOffset = this.prefixOffset(BlockId)
    
    const textOffset = offset - prefixOffset
    if (textOffset < 0) return
    
    let targetIndex = -1
    let insertPos = 0

    for (let i = 0; i < block.inline.length; i++) {
      const inline = block.inline[i]
      const start = inline.offset
      if (inline.type !== 'text') continue
      const end = start + inline.text.length

      if (textOffset >= start && textOffset <= end) {
        targetIndex = i
        insertPos = textOffset - start
        break
      }
    }

    if (targetIndex === -1 && block.inline.length > 0) {
      targetIndex = block.inline.length - 1
      const last = block.inline[targetIndex]
      if (last.type !== 'text') return
      insertPos = last.text.length
    }

    const target = block.inline[targetIndex]
    if (!target || target.type !== 'text') return

    return {
      target, 
      targetIndex,
      insertPos
    }
  }

  insertText(BlockId: string, offset: number, text: string) {
    const raw = this.getRawText(BlockId)
    if (!this.blocks.has(BlockId) || offset < 0 || offset > raw.length) return
    this.reconcileFromRawText(
      BlockId,
      raw.slice(0, offset) + text + raw.slice(offset),
      'keyboard'
    )
  }

  /**
   * 在指定偏移处删除一个字符（向后删除，即 Backspace）
   * 返回删除后需要定位的光标偏移量，或 null 表示需要跨 block 合并
   */
  deleteText(blockId: string, offset: number): { newOffset: number } | null {
    const block = this.getBlock(blockId)
    if (!block) return null

    const prefixOffset = this.prefixOffset(blockId)
    
    // 如果光标在文本开头（prefixOffset 处），需要跨 block 合并
    if (offset <= prefixOffset) {
      return null
    }

    const raw = this.getRawText(blockId)
    if (offset > raw.length) return null
    this.reconcileFromRawText(
      blockId,
      raw.slice(0, offset - 1) + raw.slice(offset),
      'keyboard'
    )
    return { newOffset: offset - 1 }
  }

  splitBlock(BlockId: string, offset: number) {
    const block = this.getBlock(BlockId)
    if (!block) return
    const raw = this.getRawText(BlockId)
    if (offset < 0 || offset > raw.length) return

    const prefixOffset = this.prefixOffset(BlockId)
    const prefix = offset >= prefixOffset ? raw.slice(0, prefixOffset) : ''
    const before = raw.slice(0, offset)
    const after = prefix + raw.slice(offset)
    const previousIds = new Set(this.blocks.keys())
    this.reconcileFromRawText(BlockId, before + preferredLineEnding(this.sourceDocument.source) + after)
    return Array.from(this.blocks.values()).find(candidate => !previousIds.has(candidate.id))
  }

  private rebindBlockIdsInOrder(blockIds: string[]): void {
    const entries = Array.from(this.blocks.entries())
    const reboundBlocks = new Map<string, BlockModel>()
    const reboundRanges = new Map<string, SourceRange>()

    entries.forEach(([id, model], index) => {
      const nextId = blockIds[index] ?? id
      if (reboundBlocks.has(nextId)) {
        throw new Error(`Duplicate block ID while restoring history: ${nextId}`)
      }
      reboundBlocks.set(nextId, nextId === model.id ? model : { ...model, id: nextId })
      const range = this.blockRanges.get(id)
      if (range) reboundRanges.set(nextId, range)
    })

    this.blocks = reboundBlocks
    this.blockRanges = reboundRanges
  }
}

function rangeKey(range: SourceRange): string {
  return `${range.from}:${range.to}`
}

function mapUnaffectedRange(range: SourceRange, transaction: EditTransaction): SourceRange | null {
  let delta = 0
  const changes = [...transaction.changes].sort((a, b) => a.range.from - b.range.from)

  for (const change of changes) {
    const changeDelta = change.insert.length - (change.range.to - change.range.from)
    if (change.range.to <= range.from) {
      delta += changeDelta
      continue
    }
    if (change.range.from >= range.to) continue
    return null
  }

  return { from: range.from + delta, to: range.to + delta }
}

function preferredLineEnding(source: string): string {
  return source.match(/\r\n|\r|\n/)?.[0] ?? '\n'
}

function isSameBlockShape(before: BlockModel, after: BlockModel): boolean {
  if (before.type !== after.type) return false
  if (before.type === 'heading') {
    return (before as HeadingBlock).headingDepth === (after as HeadingBlock).headingDepth
  }
  if (before.type === 'blockquote') {
    return (before as BlockquoteBlock).quoteDepth === (after as BlockquoteBlock).quoteDepth
  }
  if (before.type === 'list-item') {
    return JSON.stringify((before as ListItemBlock).style) === JSON.stringify((after as ListItemBlock).style)
  }
  if (before.type === 'paragraph') {
    const beforeFootnote = 'footnoteId' in before ? (before as FootnoteDefBlock).footnoteId : null
    const afterFootnote = 'footnoteId' in after ? (after as FootnoteDefBlock).footnoteId : null
    return beforeFootnote === afterFootnote
  }
  return before.type !== 'code-block' && before.type !== 'math-block' && before.type !== 'table'
}

function splitInline(inlines: InlineModel[], offset: number): {
  before: InlineModel[]
  after: InlineModel[]
} {
  const before: InlineModel[] = []
  const after: InlineModel[] = []

  inlines.forEach(inline => {
    if (inline.type === 'text') {
      const local = offset - inline.offset

      const left = {
        ...inline,
        text: inline.text.slice(0, local)
      }

      const right = {
        ...inline,
        text: inline.text.slice(local),
        offset: 0 // ⚠️ 新 block 重新计算
      }

      before.push(left)
      after.push(right)
    } else if (inline.type === 'link') {
      const local = offset - inline.offset

      const { before: c1, after: c2 } =
        splitInline(inline.children, local)

      before.push({
        ...inline,
        children: c1
      })

      after.push({
        ...inline,
        children: c2,
        offset: 0
      })
    }
  })

  return { before, after }
}

function findInlineAtOffset(inlines: InlineModel[], offset: number) {
  for (let i = 0; i < inlines.length; i++) {
    const cur = inlines[i]
    const next = inlines[i + 1]

    if (!next || offset < next.offset) {
      return { index: i, inline: cur }
    }
  }
}

function cloneBlock(origin: BlockModel, inline: InlineModel[]): ListItemBlock | BlockModel {
  if (origin.type === 'list-item') {
    const newBlock = origin as ListItemBlock
    const newStyle = newBlock.style.ordered
      ? { ordered: true as const, order: incrementOrder(newBlock.style.order) }
      : 'task' in newBlock.style && newBlock.style.task
        ? { ordered: false as const, task: true as const, checked: false }
        : { ordered: false as const }
    return {
      ...newBlock,
      id: uid(),
      inline: inline,
      style: newStyle
    }
  }
  
  return {
    ...origin,
    id: uid(),
    inline: inline
  }
}

// function cloneBlockStructure(block: BlockModel): ListItemBlock | BlockModel {
//   if (block.type === 'list-item') {
//     const newBlock = block as ListItemBlock
//     return {
//       ...newBlock,
//       id: uid(),
//       inline: [],
//       style: {
//         ordered: newBlock.style.ordered,
//         order: newBlock.style.ordered ? incrementOrder(newBlock.style.order) : ''
//       }
//     }
//   }

//   return {
//     ...block,
//     id: uid(),
//     inline: []
//   }
// }

function incrementOrder(order: string) {
  if (Number.parseInt(order)) {
    return `${Number.parseInt(order) + 1}.`
  }
  return ''
}
