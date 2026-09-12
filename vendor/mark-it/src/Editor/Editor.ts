import { DocumentController } from '../utils/DocumentController';
import { DOMController } from '../utils/DOMController';
import { DOMScheduler } from '../utils/DOMScheduler';
import { HistoryManager, type CursorInfo } from '../utils/HistoryManager';
import { EditorView } from './EditorView';
import { EditorActionType, EventController, type EditorActionContext, type SelectionSnapshot } from './EditorEventController';
import { BlockModel, BlockVisualState, ListItemBlock, INLINE_FLAG, HeadingBlock, BlockquoteBlock, CodeBlock, TableBlock, InlineModel, MathBlock, type DocumentMetadata, type HTMLPolicy } from '../types';
import { initialTokenize } from '../utils/tokenize';
import { parseLine } from '../utils/parse';
import { renderBlockHTML } from '../utils/html';
import type { SourceRange, EditOrigin } from '../utils/SourceDocument';
import { previousGraphemeBoundary, nextGraphemeBoundary } from '../utils/grapheme';

export type InlineFormatStatus = 'active' | 'inactive' | 'mixed'

export type InlineFormatState = {
  bold: InlineFormatStatus
  italic: InlineFormatStatus
  strikethrough: InlineFormatStatus
  highlight: InlineFormatStatus
  code: InlineFormatStatus
  link: InlineFormatStatus
}

export type TextBlockConversionTarget =
  | 'paragraph'
  | 'heading-1'
  | 'heading-2'
  | 'heading-3'
  | 'unordered-list'
  | 'ordered-list'
  | 'blockquote'

export type BlockTemplateTarget =
  | 'paragraph'
  | 'task-list'
  | 'code-block'
  | 'math-block'
  | 'table'

export type TableAlignmentTarget = 'left' | 'center' | 'right' | 'default'

export interface EditorOptions {
  htmlPolicy?: HTMLPolicy
}

type InlineCoverageSegment = {
  start: number
  end: number
  marks: number
  link: boolean
}

type RawInlineCoverage = {
  segments: InlineCoverageSegment[]
  rawLength: number
}

type CompletionSession = {
  blockId: string
  marker: '*' | '_' | '`'
  openerStart: number
  openerLength: number
}

export class Editor {
  view: EditorView
  doc: DocumentController
  dom: DOMController
  scheduler: DOMScheduler
  history: HistoryManager
  private onChange?: (content: string) => void;
  isHandlingDelete: boolean = false
  controller: EventController
  private handleDocumentMouseDown = (event: MouseEvent) => {
    if (event.button !== 0 || event.target !== this.view.document) return

    const blockEls = Array.from(this.view.area.querySelectorAll<HTMLElement>('.md-line-block'))
    const lastBlockEl = blockEls[blockEls.length - 1]
    if (lastBlockEl && event.clientY < lastBlockEl.getBoundingClientRect().bottom) return

    event.preventDefault()
    this.moveCursorToDocumentEnd()
  }
  private compositionContext: { range: SourceRange; cursor: CursorInfo } | null = null
  /** Undo/Redo 后跳过紧随的 SelectionChange 事件，防止展开/收起闪烁 */
  private skipNextSelectionAction: boolean = false
  /** 跨 block 选区模式：记录涉及的 block ID 列表和精确偏移量 */
  private crossBlockSelection: {
    blockIds: string[]
    /** anchor 端的 block ID（拖选起点，在整个拖选过程中固定） */
    anchorBlockId: string
    /** anchor 端的 raw offset（在首次进入跨 block 模式时、collapse 之前计算，之后不变） */
    anchorRawOffset: number
    /** focus 端的 block ID（拖选终点，随鼠标移动而更新） */
    focusBlockId: string
    /** focus 端的 raw offset（每次 selectionchange 都重新计算） */
    focusRawOffset: number
  } | null = null
  /** 跨 block 选区展开的 rAF handle（下一帧渲染前展开，延迟极小且自动合并同帧内的多次调用） */
  private crossBlockExpandRaf: number | null = null
  private completionSession: CompletionSession | null = null
  private readonly htmlPolicy: HTMLPolicy

  constructor(
    previewContainer: HTMLDivElement,
    documentTitle: string = '未命名',
    initialContent: string = '',
    metadata?: DocumentMetadata,
    options: EditorOptions = {}
  ) {
    this.htmlPolicy = options.htmlPolicy ?? 'sanitize'
    this.view = new EditorView(previewContainer, documentTitle, metadata)

    this.doc = new DocumentController(initialContent)
    this.history = new HistoryManager()

    const blocks = Array.from(this.doc.getBlocks().values())
    this.dom = new DOMController(
      this.view.area,
      blocks,
      id => this.doc.getRawText(id),
      this.htmlPolicy
    )
    this.scheduler = new DOMScheduler(this.dom, this.doc)
    this.controller = new EventController(this.view.area, action => {
    // 这里只做分发，不直接改 DOM
      this.handleEditorAction(action)
      // 修改操作完成后，通知内容变化
      this.notifyContentChange()
    })
    this.view.document.addEventListener('mousedown', this.handleDocumentMouseDown)
    this.view.area.addEventListener('mousedown', this.handleBlockMouseDown)
    this.view.area.addEventListener('mousedown', this.handleCodeBlockMouseDown)

  }

  handleEditorAction(action: EditorActionContext) {
    const {
      type,
      data,
      inputType,
      selection,
      nativeEvent,
      timestamp
    } = action

    if (type === EditorActionType.CancelCompletion) {
      this.cancelCompletionSession()
      return
    }

    if (
      this.completionSession &&
      type !== EditorActionType.InsertText &&
      type !== EditorActionType.Select
    ) {
      this.cancelCompletionSession()
    }
    if (this.completionSession && type === EditorActionType.Select) {
      this.validateCompletionSelection(selection)
    }

    // ========== Undo / Redo 处理 ==========
    if (type === EditorActionType.Undo || type === EditorActionType.Redo) {
      // 1. 获取当前光标位置信息
      const currentCursor = this.getCurrentCursorInfo(selection)

      // 2. 执行 Undo/Redo
      const restore = type === EditorActionType.Undo
        ? this.history.undo(this.doc.getHistoryState(), currentCursor)
        : this.history.redo(this.doc.getHistoryState(), currentCursor)

      if (restore) {
        this.crossBlockSelection = null
        // 3. 回放源码事务并按事务边界恢复稳定 Block ID
        this.doc.applyHistoryTransaction(restore.transaction, restore.blockIds)
        const blocks = Array.from(this.doc.getBlocks().values())
        this.dom.fullRebuild(blocks)

        // 4. 恢复光标位置并高亮 Block
        if (restore.cursor) {
          const restoredLocation = restore.cursor.sourceOffset === undefined
            ? null
            : this.doc.resolveSourceOffset(restore.cursor.sourceOffset)
          const restoredHead = restore.cursor.headSourceOffset === undefined
            ? null
            : this.doc.resolveSourceOffset(restore.cursor.headSourceOffset)

          if (
            restoredLocation &&
            restoredHead &&
            restore.cursor.headSourceOffset !== restore.cursor.sourceOffset
          ) {
            const selectedIds = this.getBlockIdsBetween(
              restoredLocation.blockId,
              restoredHead.blockId
            )
            if (selectedIds.length === 1) {
              const selectedBlock = this.doc.getBlock(selectedIds[0])
              if (selectedBlock) {
                this.dom.forceResetExpanded()
                this.dom.renderBlockExpanded(selectedBlock)
              }
            } else {
              this.dom.expandMultipleBlocks(selectedIds, this.doc.blocks)
            }
            this.dom.setSelectionByRawOffsets(
              restoredLocation.blockId,
              restoredLocation.localOffset,
              restoredHead.blockId,
              restoredHead.localOffset
            )
            if (selectedIds.length > 1) {
              this.crossBlockSelection = {
                blockIds: selectedIds,
                anchorBlockId: restoredLocation.blockId,
                anchorRawOffset: restoredLocation.localOffset,
                focusBlockId: restoredHead.blockId,
                focusRawOffset: restoredHead.localOffset
              }
            }
            this.dom.clearHighlight()
            selectedIds.forEach(id => this.dom.highlightBlock(id, BlockVisualState.active))
            this.skipNextSelectionAction = true
            return
          }

          const blockId = restoredLocation?.blockId ?? restore.cursor.blockId
          const offset = restoredLocation?.localOffset ?? restore.cursor.offset
          const block = this.doc.getBlock(blockId)
          if (block) {
            // 展开目标 block
            this.dom.expandBlock(blockId, block)

            // 根据偏移量类型选择恢复方式
            if (restore.cursor.isRawOffset) {
              // 展开模式下保存的 raw offset，用 setCursorByRawOffset 恢复
              this.dom.setCursorByRawOffset(blockId, offset)
            } else {
              // 非展开模式下保存的 semantic offset，用 setCursor 恢复
              const prefixOffset = this.doc.prefixOffset(blockId)
              this.dom.setCursor(blockId, offset, prefixOffset, 'current')
            }

            // 高亮 block
            this.dom.clearHighlight()
            this.scheduler.highlightBlock(blockId, BlockVisualState.active)
          }
        }

        // 5. 设置标志位，跳过紧随的 SelectionChange 引起的展开/收起
        this.skipNextSelectionAction = true
      }
      return
    }


    // IME owns the original source selection until commit; provisional browser
    // text is never reconciled into canonical Markdown.
    if (type === EditorActionType.CompositionStart) {
      const cursor = this.getCurrentCursorInfo(selection)
      if (cursor?.sourceOffset !== undefined) {
        const head = cursor.headSourceOffset ?? cursor.sourceOffset
        this.compositionContext = {
          range: { from: Math.min(cursor.sourceOffset, head), to: Math.max(cursor.sourceOffset, head) },
          cursor
        }
      }
      return
    }
    if (type === EditorActionType.CompositionEnd) {
      const context = this.compositionContext
      this.compositionContext = null
      if (!context) return
      if (data) {
        this.history.beginTransaction(this.doc.getHistoryState(), context.cursor)
        this.applySourceEdit(context.range, data, context.range.from + data.length, 'composition')
      }
      return
    }

    if (type === EditorActionType.Cut) {
      if (!selection || selection.isCollapsed) return
      const cursor = this.getCurrentCursorInfo(selection)
      if (cursor?.sourceOffset === undefined || cursor.headSourceOffset === undefined) return
      const range = { from: Math.min(cursor.sourceOffset, cursor.headSourceOffset), to: Math.max(cursor.sourceOffset, cursor.headSourceOffset) }
      ;(nativeEvent as ClipboardEvent | null)?.clipboardData?.setData('text/plain', this.doc.getSource().slice(range.from, range.to))
      this.history.beginTransaction(this.doc.getHistoryState(), cursor)
      this.applySourceEdit(range, '', range.from, 'keyboard')
      return
    }

    // ========== 修改操作前保存快照（用于 Undo） ==========
    const isMutatingAction = (
      type === EditorActionType.InsertText ||
      type === EditorActionType.Paste ||
      type === EditorActionType.DeleteBackward ||
      type === EditorActionType.DeleteForward ||
      type === EditorActionType.InsertLineBreak ||
      type === EditorActionType.FormatToggle ||
      type === EditorActionType.Indent ||
      type === EditorActionType.Outdent ||
      type === EditorActionType.Drop
    )
    if (isMutatingAction) {
      const cursorInfo = this.getCurrentCursorInfo(selection)
      this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)
    }

    // beforeinput distinguishes Enter (insertParagraph) from Shift+Enter
    // (insertLineBreak). A soft break edits source literally: keep the marker,
    // copy only leading whitespace, and do not continue/exit a list or fence.
    if (type === EditorActionType.InsertLineBreak && inputType === 'insertLineBreak') {
      const cursor = this.getCurrentCursorInfo(selection)
      if (cursor?.sourceOffset === undefined || cursor.headSourceOffset === undefined) return
      const range = { from: Math.min(cursor.sourceOffset, cursor.headSourceOffset), to: Math.max(cursor.sourceOffset, cursor.headSourceOffset) }
      const insert = this.getSoftLineBreakText(range.from)
      this.applySourceEdit(range, insert, range.from + insert.length, 'keyboard')
      return
    }


    // Resolve the live native selection, including Element endpoints. Do not
    // rely on the asynchronous cross-block expansion cache to define an edit.
    if (selection && !selection.isCollapsed && [
      EditorActionType.InsertText, EditorActionType.Paste, EditorActionType.DeleteBackward,
      EditorActionType.DeleteForward, EditorActionType.InsertLineBreak
    ].includes(type)) {
      const cursor = this.getCurrentCursorInfo(selection)
      if (cursor?.sourceOffset === undefined || cursor.headSourceOffset === undefined) return
      const range = { from: Math.min(cursor.sourceOffset, cursor.headSourceOffset), to: Math.max(cursor.sourceOffset, cursor.headSourceOffset) }
      const insert = type === EditorActionType.InsertLineBreak ? '\n'
        : type === EditorActionType.InsertText || type === EditorActionType.Paste ? data ?? '' : ''
      this.applySourceEdit(range, insert, range.from + insert.length, type === EditorActionType.Paste ? 'paste' : 'keyboard')
      return
    }

    if (type === EditorActionType.MoveCursorDown) {
      const block = this.doc.getBlock(getIdFromBlock(selection!.anchorNode!))
      if (!block) return

      const caretX = parseFloat(data ?? '0')
      
      // 先判断目标是同 block 还是跨 block
      const moveTarget = this.dom.getVerticalMoveTarget(block.id, 'down')
      if (moveTarget && moveTarget.type === 'cross-block') {
        // 跨 block 移动：先展开目标 block，收起当前 block
        const expandedBlockId = this.dom.getExpandedBlockId()
        if (expandedBlockId) {
          const oldBlock = this.doc.getBlock(expandedBlockId)
          if (oldBlock) this.dom.collapseBlock(oldBlock)
        }
        const targetBlock = this.doc.getBlock(moveTarget.targetBlockId)
        if (targetBlock) {
          this.dom.expandBlock(moveTarget.targetBlockId, targetBlock)
        }
      }
      
      // 在展开后的 DOM 上执行像素定位
      this.dom.setCursorByPixel(block.id, caretX, 'down')
      // 上下键移动已处理完展开/收起，直接返回，避免末尾逻辑用旧 selection 重复操作
      return

    } else if (type === EditorActionType.MoveCursorUp) {
      const block = this.doc.getBlock(getIdFromBlock(selection!.anchorNode!))
      if (!block) return

      const caretX = parseFloat(data ?? '0')
      
      // 先判断目标是同 block 还是跨 block
      const moveTarget = this.dom.getVerticalMoveTarget(block.id, 'up')
      if (moveTarget && moveTarget.type === 'cross-block') {
        // 跨 block 移动：先展开目标 block，收起当前 block
        const expandedBlockId = this.dom.getExpandedBlockId()
        if (expandedBlockId) {
          const oldBlock = this.doc.getBlock(expandedBlockId)
          if (oldBlock) this.dom.collapseBlock(oldBlock)
        }
        const targetBlock = this.doc.getBlock(moveTarget.targetBlockId)
        if (targetBlock) {
          this.dom.expandBlock(moveTarget.targetBlockId, targetBlock)
        }
      }
      
      // 在展开后的 DOM 上执行像素定位
      this.dom.setCursorByPixel(block.id, caretX, 'up')
      // 上下键移动已处理完展开/收起，直接返回，避免末尾逻辑用旧 selection 重复操作
      return
    }

    if (type === EditorActionType.InsertText) {
      const block = this.doc.getBlock(getIdFromBlock(selection!.anchorNode!))
      const root = getBlockAnchor(selection!.anchorNode!)
      if (!block || !root) return

      // 当 block 处于展开模式时，所有输入都走全行 reconcile 路径
      // 因为展开模式下标记符是可见文本，任何输入都可能影响标记符的配对关系
      const isExpanded = this.dom.getExpandedBlockId() === block.id

      if (this.tryHandleCompletionSession(block, root, selection!, data ?? '', isExpanded)) {
        return
      }

      if (this.tryHandleMarkdownAutoComplete(block, root, selection!, data ?? '', isExpanded)) {
        return
      }
      
      if (isExpanded) {
        // 展开模式：如果有选区，先删除选中内容
        if (!selection!.isCollapsed) {
          this.handleReplaceSelection(block, root, selection!, data!)
        } else {
          this.handleInsertInMarker(block, root, selection!.anchorNode!, selection!.anchorOffset, data!)
        }
        return  // 已处理完展开/收起和光标定位，不再执行末尾逻辑
      } else {
        // 正常路径：字符级 insertText
        const offset = computeSemanticOffset(root, selection!.anchorNode!, selection!.anchorOffset, this.doc.prefixOffset(block.id))
        if (offset === null) return
        this.scheduler.insertText(block.id, offset, data!, offset + data!.length)
      }
    }


    if (type === EditorActionType.Paste) {
      const cursor = this.getCurrentCursorInfo(selection)
      if (cursor?.sourceOffset === undefined || !data) return
      const offset = cursor.sourceOffset
      this.applySourceEdit({ from: offset, to: offset }, data, offset + data.length, 'paste')
      return
    }


    if (type === EditorActionType.DeleteBackward || type === EditorActionType.DeleteForward) {
      const cursor = this.getCurrentCursorInfo(selection)
      if (!cursor) return
      const block = this.doc.getBlock(cursor.blockId)
      if (!block) return
      const raw = this.doc.getRawText(block.id)
      const offset = cursor.offset
      if (type === EditorActionType.DeleteBackward) {
        if (offset === 0) this.handleMergeWithPreviousBlock(block.id)
        else {
          const from = previousGraphemeBoundary(raw, offset)
          this.applyRawReconcile(block, raw.slice(0, from) + raw.slice(offset), from)
        }
      } else if (offset === raw.length) this.handleMergeWithNextBlock(block.id)
      else {
        const to = nextGraphemeBoundary(raw, offset)
        this.applyRawReconcile(block, raw.slice(0, offset) + raw.slice(to), offset)
      }
      return
    }

    if (action.type === EditorActionType.InsertLineBreak) {
      const block = this.doc.getBlock(getIdFromBlock(selection!.anchorNode!))
      const root = getBlockAnchor(selection!.anchorNode!)
      if (!block || !root) return

      const isExpanded = this.dom.getExpandedBlockId() === block.id

      if (isExpanded) {
        // 有选区时，先删除选中内容，再在删除后的位置换行
        let effectiveRawText = this.doc.getRawText(block.id)
        let effectiveRawOffset: number | null = null

        if (!selection!.isCollapsed) {
          const range = getSelectionRawRange(root, selection!)
          if (!range) return
          const { start, end } = range
          effectiveRawText = effectiveRawText.slice(0, start) + effectiveRawText.slice(end)
          effectiveRawOffset = start
          // 先更新 model
          const tempEffect = this.doc.reconcileFromRawText(block.id, effectiveRawText.trim() === '' ? '' : effectiveRawText)
          if (!tempEffect) return
          if (tempEffect.kind === 'block-transform') {
            this.dom.replaceBlock(tempEffect.from, tempEffect.to)
          }
          // 用删除后的 block 继续换行流程
          const updatedBlock2 = this.doc.getBlock(block.id)
          if (!updatedBlock2) return
          // 重新取 rawText（reconcile 可能改变了 block 类型）
          effectiveRawText = this.doc.getRawText(block.id)
        } else {
          effectiveRawOffset = computeRawOffset(root, selection!.anchorNode!, selection!.anchorOffset)
        }

        const rawText = effectiveRawText
        const rawOffset = effectiveRawOffset
        const currentBlock = this.doc.getBlock(block.id) ?? block

        // 代码块换行：在代码块内容中插入换行符，不拆分 block
        // 自动保持当前行的缩进
        if (currentBlock.type === 'code-block') {
          let effectiveOff = rawOffset ?? 0
          const firstLineBreak = rawText.indexOf('\n')
          if (this.exitFencedBlockAfterClosingLine(currentBlock, rawText, effectiveOff)) return

          // 光标在开头 fence / 语言标记行时，Enter 创建第 1 行空代码行。
          if (firstLineBreak !== -1 && effectiveOff <= firstLineBreak) {
            const newRawText = rawText.slice(0, firstLineBreak + 1) + '\n' + rawText.slice(firstLineBreak + 1)
            this.applyRawReconcile(currentBlock, newRawText, firstLineBreak + 1)
            return
          }

          // 找到当前行的行首，提取缩进
          const lineStart = rawText.lastIndexOf('\n', effectiveOff - 1) + 1
          const currentLine = rawText.slice(lineStart, effectiveOff)
          const indentMatch = currentLine.match(/^(\s*)/)
          const indent = indentMatch ? indentMatch[1] : ''
          const newRawText = rawText.slice(0, effectiveOff) + '\n' + indent + rawText.slice(effectiveOff)
          this.applyRawReconcile(currentBlock, newRawText, effectiveOff + 1 + indent.length)
          return
        }

        // 数学公式块换行：在内容中插入换行符，不拆分 block
        if (currentBlock.type === 'math-block') {
          let effectiveOff = rawOffset ?? 0
          const firstLineBreak = rawText.indexOf('\n')
          if (this.exitFencedBlockAfterClosingLine(currentBlock, rawText, effectiveOff)) return

          // 光标在开头 $$ 行时，Enter 在 $$ 后插入新行
          if (firstLineBreak !== -1 && effectiveOff <= firstLineBreak) {
            const newRawText = rawText.slice(0, firstLineBreak + 1) + '\n' + rawText.slice(firstLineBreak + 1)
            this.applyRawReconcile(currentBlock, newRawText, firstLineBreak + 1)
            return
          }

          const newRawText = rawText.slice(0, effectiveOff) + '\n' + rawText.slice(effectiveOff)
          this.applyRawReconcile(currentBlock, newRawText, effectiveOff + 1)
          return
        }


        if (block.type === 'blank') {
          const offset = rawOffset ?? 0
          this.applyRawReconcile(block, rawText.slice(0, offset) + '\n' + rawText.slice(offset), offset + 1)
          return
        }

        if (rawOffset === null) return

        const completedCodeBlock = this.tryCompleteCodeBlockFromOpeningFence(currentBlock, rawText, rawOffset)
        if (completedCodeBlock) return

        // ========== 列表项 Enter 行为增强 ==========
        if (currentBlock.type === 'list-item') {
          const listItem = currentBlock as ListItemBlock
          const prefixLen = this.doc.prefixOffset(currentBlock.id)
          const contentAfterPrefix = rawText.slice(prefixLen).trim()

          // 空列表项按 Enter → 退出列表（变为空行）

          if (contentAfterPrefix === '') {
            this.applyRawReconcile(currentBlock, '', 0)
            return
          }

          // marker 内部按 Enter 必须遵循可见 raw 位置，不能自动补一个列表前缀。
          // 只有光标已到正文起点/正文内时，才使用“继续下一项”的语义。
          if (rawOffset >= prefixLen) {
            // 非空列表项按 Enter → 拆分，新行继承列表结构（缩进 + marker）
            const beforeRaw = rawText.slice(0, rawOffset)
            const afterContent = rawText.slice(rawOffset)


            // 构造新行的 raw text：继承缩进 + marker 前缀 + 光标后的内容
            const indent = rawText.match(/^[ \t]*/)?.[0] ?? ''
            let newMarker: string
            if (listItem.style.ordered) {
              // 有序列表：自动递增序号
              const orderNum = parseInt(listItem.style.order) || 1
              newMarker = `${orderNum + 1}. `
            } else if ('task' in listItem.style && listItem.style.task) {
              const bullet = ('bullet' in listItem.style ? listItem.style.bullet : undefined) ?? '-'
              newMarker = `${bullet} [ ]${listItem.style.markerSpacing ?? ' '}`
            } else {
              const bullet = ('bullet' in listItem.style ? listItem.style.bullet : undefined) ?? '-'
              newMarker = `${bullet} `
            }

            const prefix = indent + newMarker
            this.applyRawReconcile(currentBlock, beforeRaw + '\n' + prefix + afterContent, beforeRaw.length + 1 + prefix.length)
            return
          }
        }


        const prefixLen = this.doc.prefixOffset(block.id)
        const prefix = rawOffset >= prefixLen ? rawText.slice(0, prefixLen) : ''
        this.applyRawReconcile(currentBlock,
          rawText.slice(0, rawOffset) + '\n' + prefix + rawText.slice(rawOffset),
          rawOffset + 1 + prefix.length)
        return
      } else {
        const offset = computeSemanticOffset(root, selection!.anchorNode!, selection!.anchorOffset, this.doc.prefixOffset(block.id))
        if (offset === null) return
        const rawText = this.doc.getRawText(block.id)
        const completedCodeBlock = this.tryCompleteCodeBlockFromOpeningFence(block, rawText, offset)
        if (completedCodeBlock) return
        this.scheduler.handleInsertLineBreak(block.id, offset)
      }
    }

    // ========== 图片拖拽上传处理 ==========
    if (type === EditorActionType.Drop) {
      const files = action.files
      if (files && files.length > 0) {
        this.handleImageDrop(selection, files)
      }
      return
    }

    // ========== 链接 hover 弹窗处理 ==========
    if (type === EditorActionType.LinkClick) {
      if (data) {
        try {
          const linkInfo = JSON.parse(data)
          this.handleLinkHover(linkInfo, action.linkElement ?? null)
        } catch {}
      }
      return
    }

    // ========== 图片 hover 弹窗处理 ==========
    if (type === EditorActionType.ImageHover) {
      if (data) {
        try {
          const imageInfo = JSON.parse(data)
          this.handleImageHover(imageInfo)
        } catch {}
      }
      return
    }

    // ========== 脚注跳转处理 ==========
    if (type === EditorActionType.FootnoteJump) {
      if (data) {
        this.handleFootnoteJump(data)
      }
      return
    }

    // ========== 文档末尾空白区域点击 ==========
    if (type === EditorActionType.BlankAreaClick) {
      this.moveCursorToDocumentEnd()
      return
    }

    // ========== 格式化快捷键处理 ==========
    if (type === EditorActionType.FormatToggle) {
      this.handleFormatToggle(selection, data ?? '')
      return
    }

    // ========== Tab / Shift+Tab 缩进处理 ==========
    if (type === EditorActionType.Indent || type === EditorActionType.Outdent) {
      this.handleIndent(selection, type === EditorActionType.Indent ? 'indent' : 'outdent')
      return
    }

    // ========== Copy / Cut 处理 ==========
    if (type === EditorActionType.Copy) {
      if (selection && nativeEvent) {
        const text = this.getSelectedText(selection)
        if (text) {
          const clipboardEvent = nativeEvent as ClipboardEvent
          clipboardEvent.clipboardData?.setData('text/plain', text)
        }
      }
      return
    }

    // Native select-all can keep either endpoint on the editor Element itself.
    // Redrawing its selected children makes WebKit move the live endpoint to
    // the replaced child's start, silently shrinking the selection. Keep this
    // DOM range intact until the edit resolves it to canonical source offsets.
    if (type === EditorActionType.Select && selection && !selection.isCollapsed &&
      (selection.anchorNode === this.view.area || selection.focusNode === this.view.area)) {
      if (this.crossBlockExpandRaf !== null) cancelAnimationFrame(this.crossBlockExpandRaf)
      this.crossBlockExpandRaf = null
      this.crossBlockSelection = null
      this.skipNextSelectionAction = false
      return
    }

    // ========== 跳过 Undo/Redo 或展开操作后紧随的 SelectionChange ==========
    if (this.skipNextSelectionAction && type === EditorActionType.Select) {
      this.skipNextSelectionAction = false

      // skip 时仍需检测：如果选区已回到单 block/collapsed，需要清理跨 block 状态
      const isCurrentCrossBlock = selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode &&
        getIdFromBlock(selection.anchorNode) !== getIdFromBlock(selection.focusNode) &&
        getIdFromBlock(selection.anchorNode) !== '' && getIdFromBlock(selection.focusNode) !== ''

      if (isCurrentCrossBlock) {
        // 选区仍是跨 block 的，这是我们重建选区触发的 selectionchange，直接跳过
        return
      }

      // 选区已回到单 block/collapsed，需要清理跨 block 状态
      if (this.crossBlockExpandRaf !== null) {
        cancelAnimationFrame(this.crossBlockExpandRaf)
        this.crossBlockExpandRaf = null
      }
      if (this.crossBlockSelection) {
        this.crossBlockSelection = null
      }
      if (this.dom.isMultiExpanded()) {
        this.dom.collapseAllMultiExpanded(this.doc.blocks)
      }
      // 不 return，继续执行后面的单 block 展开/高亮逻辑
    }

    // ========== 跨 Block 选中检测 ==========
    if (selection && !selection.isCollapsed && selection.anchorNode && selection.focusNode) {
      const anchorBlockId = getIdFromBlock(selection.anchorNode)
      const focusBlockId = getIdFromBlock(selection.focusNode)
      if (anchorBlockId && focusBlockId && anchorBlockId !== focusBlockId) {
        const blockIds = this.getBlockIdsBetween(anchorBlockId, focusBlockId)

        // 辅助函数：根据 block 的展开状态计算 raw offset
        const calcRawOffset = (blockId: string, node: Node, offset: number): number | null => {
          const blockEl = this.dom.getNodeById(blockId)
          if (!blockEl) return null
          const isBlockExpanded = this.dom.getExpandedBlockId() === blockId
          const isBlockMultiExpanded = this.dom.isBlockMultiExpanded(blockId)
          if (isBlockExpanded || isBlockMultiExpanded) {
            return computeRawOffset(blockEl, node, offset)
          }
          // 代码块等没有 .md-inline-content 的 block 类型，直接用 computeRawOffset
          const block = this.doc.getBlock(blockId)
          if (block && (block.type === 'code-block' || block.type === 'hr' || block.type === 'blank')) {
            return computeRawOffset(blockEl, node, offset)
          }
          return computeSemanticOffset(blockEl, node, offset, this.doc.prefixOffset(blockId))
        }

        // 计算 focus 端 raw offset（不展开 block，保留浏览器原生选区）
        const focusRawOff = calcRawOffset(focusBlockId, selection.focusNode, selection.focusOffset)

        if (this.crossBlockSelection) {
          // 已处于跨 block 模式：anchor 端不变，只更新 focus 端和 block 范围
          if (focusRawOff !== null) {
            this.crossBlockSelection.blockIds = blockIds
            this.crossBlockSelection.focusBlockId = focusBlockId
            this.crossBlockSelection.focusRawOffset = focusRawOff
          }
        } else {
          // 首次进入跨 block 模式：计算 anchor 端 raw offset
          const anchorRawOff = calcRawOffset(anchorBlockId, selection.anchorNode, selection.anchorOffset)

          if (anchorRawOff !== null && focusRawOff !== null) {
            this.crossBlockSelection = {
              blockIds,
              anchorBlockId,
              anchorRawOffset: anchorRawOff,
              focusBlockId,
              focusRawOffset: focusRawOff
            }
          }
        }

        // 高亮涉及的 block
        this.dom.clearHighlight()
        for (let i = 0; i < blockIds.length; i++) {
          const pos = blockIds.length === 1 ? 'only' as const
            : i === 0 ? 'first' as const
            : i === blockIds.length - 1 ? 'last' as const
            : 'middle' as const
          this.dom.highlightBlock(blockIds[i], BlockVisualState.active, pos)
        }

        // 防抖展开：选区变化停止后延迟展开，避免拖选/键盘选择过程中破坏原生选区
        this.scheduleCrossBlockExpand()
        return
      }
    }

    // 如果之前处于跨 block 选区模式，但现在选区回到了单 block 或 collapsed，
    // 需要清除跨 block 选区状态，取消 pending rAF，并收起之前展开的 block
    if (this.crossBlockSelection || this.crossBlockExpandRaf !== null) {
      if (this.crossBlockExpandRaf !== null) {
        cancelAnimationFrame(this.crossBlockExpandRaf)
        this.crossBlockExpandRaf = null
      }
      this.crossBlockSelection = null
    }

    // 如果之前处于多 block 展开状态，但现在选区回到了单 block 或 collapsed，
    // 需要收起多 block 展开状态
    if (this.dom.isMultiExpanded()) {
      this.dom.collapseAllMultiExpanded(this.doc.blocks)
    }

    if (selection && selection.anchorNode === selection.focusNode) { 
      this.dom.clearHighlight()
      if (selection.anchorNode)
        this.scheduler.highlightBlock(getIdFromBlock(selection.anchorNode), BlockVisualState.active)
    }

    // ========== Block 级别标记符展开/收起逻辑 ==========
    // 当光标进入某个 Block 时，展开该 Block 的所有标记符
    // 当光标离开时，收起
    if (selection && selection.anchorNode) {
      const currentBlockId = getIdFromBlock(selection.anchorNode)
      const expandedBlockId = this.dom.getExpandedBlockId()

      if (currentBlockId && currentBlockId !== expandedBlockId) {
        // 光标进入了新的 block，收起旧的，展开新的
        if (expandedBlockId) {
          const oldBlock = this.doc.getBlock(expandedBlockId)
          if (oldBlock) {
            this.dom.collapseBlock(oldBlock)
          }
        }
        const newBlock = this.doc.getBlock(currentBlockId)
        if (newBlock) {
          this.dom.expandBlock(currentBlockId, newBlock)
        }
      } else if (!currentBlockId && expandedBlockId) {
        // 光标离开了所有 block
        const oldBlock = this.doc.getBlock(expandedBlockId)
        if (oldBlock) {
          this.dom.collapseBlock(oldBlock)
        }
      }
    }
  }

    
  /**
   * 处理多行粘贴
   * 第一行内容插入当前 block 的光标位置，
   * 后续每行各创建一个新 block 并按顺序插入
   */
  private handlePasteMultiLine(
    block: BlockModel,
    blockEl: HTMLElement,
    selection: SelectionSnapshot,
    lines: string[],
    isExpanded: boolean
  ) {
    // 1. 获取当前光标在 raw text 中的位置
    const rawText = this.doc.getRawText(block.id)
    const rawOffset = computeRawOffset(blockEl, selection.anchorNode!, selection.anchorOffset)
    if (rawOffset === null) return

    // 2. 将光标前后内容与粘贴内容拼接，形成完整的多行文本
    const beforeCursor = rawText.slice(0, rawOffset)
    const afterCursor = rawText.slice(rawOffset)
    const firstLineRaw = beforeCursor + lines[0]
    const lastLineRaw = lines[lines.length - 1] + afterCursor

    // 3. 构造完整的粘贴后文本，使用 initialTokenize 进行多行结构识别
    //    这样代码块/公式块/表格等跨行结构能被正确合并
    const fullPastedText = [firstLineRaw, ...lines.slice(1, -1), lastLineRaw].join('\n')
    const tokens = initialTokenize(fullPastedText)

    // 4. 收起展开状态
    if (isExpanded) {
      this.dom.collapseBlock(block)
      this.dom.forceResetExpanded()
    }

    // 5. 用第一个 token 更新当前 block
    const firstToken = tokens[0]
    const effect = this.doc.reconcileFromRawText(block.id, firstToken.raw.trim() === '' ? '' : firstToken.raw)
    if (!effect) return
    if (effect.kind === 'code-block-degrade') return
    const updatedBlock = effect.kind === 'block-transform' ? effect.to : effect.block
    this.dom.replaceBlock(block, updatedBlock)

    // 6. 创建后续 token 对应的 block
    let prevBlock = updatedBlock
    for (let i = 1; i < tokens.length; i++) {
      const newBlock = this.doc.createBlockFromRawText(tokens[i].raw, prevBlock.id)
      this.dom.insertBlock(prevBlock, newBlock)
      prevBlock = newBlock
    }

    // 7. 展开最后一个 block 并定位光标
    const lastBlock = prevBlock
    this.dom.renderBlockExpanded(lastBlock)
    // 光标定位到粘贴内容末尾（即最后一个 token 中，afterCursor 之前的位置）
    const lastTokenRaw = this.doc.getRawText(lastBlock.id)
    const cursorRawOffset = lastTokenRaw.length - afterCursor.length
    const lastPrefixOffset = this.doc.prefixOffset(lastBlock.id)
    this.dom.setCursorByRawOffset(lastBlock.id, Math.max(lastPrefixOffset, cursorRawOffset))

    // 8. 高亮
    this.dom.clearHighlight()
    this.scheduler.highlightBlock(lastBlock.id, BlockVisualState.active)
    this.skipNextSelectionAction = true
  }


  /**
   * 处理跨 Block 合并（行首 Backspace）
   * 将当前 block 的内容合并到前一个 block 末尾，删除当前 block，
   * 然后展开合并后的 block 并定位光标到合并点
   */

  private handleMergeWithPreviousBlock(blockId: string) {
    const previousId = this.doc.getPreviousBlockId(blockId)
    const previous = previousId ? this.doc.getSourceRange(previousId) : null
    const current = this.doc.getSourceRange(blockId)
    if (!previous || !current) return
    this.applySourceEdit({ from: previous.to, to: current.from }, '', previous.to, 'keyboard', previousId!)
  }

  private handleMergeWithNextBlock(blockId: string) {
    const nextId = this.doc.getNextBlockId(blockId)
    const next = nextId ? this.doc.getSourceRange(nextId) : null
    const current = this.doc.getSourceRange(blockId)
    if (!next || !current) return
    this.applySourceEdit({ from: current.to, to: next.from }, '', current.to, 'keyboard', blockId)
  }

  /**
   * 调度跨 block 选区展开（requestAnimationFrame）
   * 每次 selectionchange 检测到跨 block 选区时调用。
   * 同一帧内多次调用只会执行最后一次，延迟极小（~16ms）。
   */
  private scheduleCrossBlockExpand(): void {
    if (this.crossBlockExpandRaf !== null) {
      cancelAnimationFrame(this.crossBlockExpandRaf)
    }
    this.crossBlockExpandRaf = requestAnimationFrame(() => {
      this.crossBlockExpandRaf = null
      this.executeCrossBlockExpand()
    })
  }

  /**
   * 执行跨 block 选区展开
   * 展开所有涉及的 block，用保存的精确 raw offset 重建选区，并高亮。
   */
  private executeCrossBlockExpand(): void {
    if (!this.crossBlockSelection) return
    const saved = this.crossBlockSelection

    // 展开所有涉及的 block
    this.dom.expandMultipleBlocks(saved.blockIds, this.doc.blocks)

    // 用保存的精确 raw offset 重建选区
    this.dom.setSelectionByRawOffsets(
      saved.anchorBlockId, saved.anchorRawOffset,
      saved.focusBlockId, saved.focusRawOffset
    )

    // 高亮涉及的 block
    this.dom.clearHighlight()
    for (let i = 0; i < saved.blockIds.length; i++) {
      const pos = saved.blockIds.length === 1 ? 'only' as const
        : i === 0 ? 'first' as const
        : i === saved.blockIds.length - 1 ? 'last' as const
        : 'middle' as const
      this.dom.highlightBlock(saved.blockIds[i], BlockVisualState.active, pos)
    }

    // 跳过展开操作触发的 selectionchange
    this.skipNextSelectionAction = true
  }

  destroy() {
    // 清理 rAF
    if (this.crossBlockExpandRaf !== null) {
      cancelAnimationFrame(this.crossBlockExpandRaf)
      this.crossBlockExpandRaf = null
    }
    this.controller.destroy()
    this.view.document.removeEventListener('mousedown', this.handleDocumentMouseDown)
    this.view.area.removeEventListener('mousedown', this.handleBlockMouseDown)
    this.view.area.removeEventListener('mousedown', this.handleCodeBlockMouseDown)
    this.dom.destroy()
    this.scheduler.destroy()
    this.view.destroy()
  }

  /**
   * 获取完整的 Markdown 源文本
   * 遍历所有 blockModel，逐个调用 getRawText 并用换行符拼接
   */
  getMarkdownSource(): string {
    return this.doc.getSource()
  }

  /**
   * 导出为 HTML 字符串
   * 将所有 block model 转换为语义化 HTML
   */
  exportHTML(): string {
    const parts: string[] = []

    for (const [, block] of this.doc.getBlocks()) {
      parts.push(renderBlockHTML(block, this.htmlPolicy))
    }

    return parts.join('\n')
  }

  /**
   * 查找文档中所有匹配的文本
   * 返回匹配位置数组：[{ blockId, offset, length }]
   */
  findAll(query: string, caseSensitive: boolean = false): { blockId: string; offset: number; length: number }[] {
    if (!query) return []

    const results: { blockId: string; offset: number; length: number }[] = []
    const flags = caseSensitive ? 'g' : 'gi'
    const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)

    for (const [id] of this.doc.getBlocks()) {
      const rawText = this.doc.getRawText(id)
      let match: RegExpExecArray | null
      while ((match = regex.exec(rawText)) !== null) {
        results.push({ blockId: id, offset: match.index, length: match[0].length })
      }
    }

    return results
  }

  /**
   * 查找并替换文档中所有匹配的文本
   * 返回替换的数量
   */
  replaceAll(query: string, replacement: string, caseSensitive: boolean = false): number {
    if (!query) return 0

    const cursorInfo = this.getCurrentCursorInfo(
      this.controller['captureSelection']?.() ?? null
    )
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    let count = 0
    const flags = caseSensitive ? 'g' : 'gi'
    const changes: { range: { from: number; to: number }; insert: string }[] = []

    for (const [id] of this.doc.getBlocks()) {
      const rawText = this.doc.getRawText(id)
      const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
      const newRawText = rawText.replace(regex, () => { count++; return replacement })

      if (newRawText !== rawText) {
        const range = this.doc.getSourceRange(id)
        if (range) changes.push({ range, insert: newRawText })
      }
    }

    if (changes.length === 0) return 0
    this.doc.applyTransaction({ changes, origin: 'command' })
    this.dom.fullRebuild(Array.from(this.doc.getBlocks().values()))
    if (cursorInfo && this.doc.getBlock(cursorInfo.blockId)) {
      this.rebuildAndFocusBlock(cursorInfo.blockId, cursorInfo.offset)
    }
    this.notifyContentChange()
    return count
  }

  /**
   * 注册内容变化回调
   * 每次用户编辑操作（insertText、delete、paste、composition、lineBreak、undo/redo）后触发
   */
  onContentChange(callback: (markdown: string) => void): void {
    this.onChange = callback
  }

  /**
   * 通知内容变化（内部方法）
   */
  private notifyContentChange(): void {
    if (this.onChange) {
      this.onChange(this.getMarkdownSource())
    }
  }

  // ========== 公开格式化 API ==========

  /** 切换加粗格式 */
  toggleBold(): void {
    this.executeFormat('bold')
  }

  /** 切换斜体格式 */
  toggleItalic(): void {
    this.executeFormat('italic')
  }

  /** 切换删除线格式 */
  toggleStrikethrough(): void {
    this.executeFormat('strikethrough')
  }

  /** 切换行内代码格式 */
  toggleCode(): void {
    this.executeFormat('code')
  }

  /** 切换高亮格式 */
  toggleHighlight(): void {
    this.executeFormat('highlight')
  }

  /** 插入链接 */
  insertLink(): void {
    this.executeFormat('link')
  }

  insertBlankBlockBefore(blockId: string): boolean {
    const anchor = this.doc.getBlock(blockId)
    if (!anchor) return false

    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const inserted = this.doc.createBlockFromRawTextBefore('', blockId)
    if (!inserted) return false

    this.rebuildAndFocusBlock(inserted.id, 0)
    this.notifyContentChange()
    return true
  }

  insertBlankBlockAfter(blockId: string): boolean {
    const anchor = this.doc.getBlock(blockId)
    if (!anchor) return false

    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const inserted = this.doc.createBlockFromRawText('', blockId)
    this.rebuildAndFocusBlock(inserted.id, 0)
    this.notifyContentChange()
    return true
  }

  duplicateBlockAfter(blockId: string): boolean {
    const anchor = this.doc.getBlock(blockId)
    if (!anchor) return false

    const rawText = this.doc.getRawText(blockId)
    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const inserted = this.doc.createBlockFromRawText(rawText, blockId)
    this.rebuildAndFocusBlock(inserted.id, this.doc.prefixOffset(inserted.id))
    this.notifyContentChange()
    return true
  }

  deleteBlock(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block) return false

    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const result = this.doc.deleteBlock(blockId)
    if (!result) return false

    this.rebuildAndFocusBlock(result.focusBlockId, this.doc.prefixOffset(result.focusBlockId))
    this.notifyContentChange()
    return true
  }

  moveBlockUp(blockId: string): boolean {
    return this.moveBlock(blockId, 'up')
  }

  moveBlockDown(blockId: string): boolean {
    return this.moveBlock(blockId, 'down')
  }

  insertTemplateBlockAfter(blockId: string, template: BlockTemplateTarget): boolean {
    const anchor = this.doc.getBlock(blockId)
    if (!anchor) return false

    const details = this.getBlockTemplateDetails(template)
    if (!details) return false

    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const inserted = this.doc.createBlockFromRawText(details.rawText, blockId)
    this.rebuildAndFocusBlock(inserted.id, details.cursorRawOffset)
    this.notifyContentChange()
    return true
  }

  insertTemplateBlockBefore(blockId: string, template: BlockTemplateTarget): boolean {
    const anchor = this.doc.getBlock(blockId)
    if (!anchor) return false

    const details = this.getBlockTemplateDetails(template)
    if (!details) return false

    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const inserted = this.doc.createBlockFromRawTextBefore(details.rawText, blockId)
    if (!inserted) return false

    this.rebuildAndFocusBlock(inserted.id, details.cursorRawOffset)
    this.notifyContentChange()
    return true
  }

  toggleTaskListItem(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'list-item') return false

    const listItem = block as ListItemBlock
    if (!('task' in listItem.style) || !listItem.style.task) return false

    const rawText = this.doc.getRawText(blockId)
    const nextRawText = rawText.replace(
      /^(\s*[-*+] \[)(?: |x|X)(\]\s*)/,
      `$1${listItem.style.checked ? ' ' : 'x'}$2`
    )
    if (nextRawText === rawText) return false

    return this.applyBlockRawCommand(blockId, nextRawText, this.doc.prefixOffset(blockId))
  }

  convertListItemToTask(blockId: string, checked = false): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'list-item') return false

    const listItem = block as ListItemBlock
    if ('task' in listItem.style && listItem.style.task) return false

    const contentRaw = this.getConvertibleBlockContentRaw(blockId)
    if (contentRaw === null) return false

    const indent = ' '.repeat(block.nesting ?? 0)
    const nextRawText = `${indent}- [${checked ? 'x' : ' '}] ${contentRaw}`
    return this.applyBlockRawCommand(blockId, nextRawText, this.doc.prefixOffset(blockId) + 4)
  }

  convertTaskListItemToList(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'list-item') return false

    const listItem = block as ListItemBlock
    if (!('task' in listItem.style) || !listItem.style.task) return false

    const contentRaw = this.getConvertibleBlockContentRaw(blockId)
    if (contentRaw === null) return false

    const indent = ' '.repeat(block.nesting ?? 0)
    const nextRawText = `${indent}- ${contentRaw}`
    return this.applyBlockRawCommand(blockId, nextRawText, this.doc.prefixOffset(blockId) - 4)
  }

  indentListItem(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'list-item') return false

    const rawText = this.doc.getRawText(blockId)
    return this.applyBlockRawCommand(blockId, `    ${rawText}`, this.doc.prefixOffset(blockId) + 4)
  }

  outdentListItem(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'list-item') return false

    const nesting = block.nesting ?? 0
    if (nesting <= 0) return false

    const rawText = this.doc.getRawText(blockId)
    const spacesToRemove = Math.min(4, nesting)
    const nextRawText = rawText.slice(spacesToRemove)
    return this.applyBlockRawCommand(blockId, nextRawText, Math.max(0, this.doc.prefixOffset(blockId) - spacesToRemove))
  }

  increaseBlockquoteLevel(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'blockquote') return false

    const rawText = this.doc.getRawText(blockId)
    return this.applyBlockRawCommand(blockId, `>${rawText}`, this.doc.prefixOffset(blockId) + 1)
  }

  decreaseBlockquoteLevel(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'blockquote') return false

    const rawText = this.doc.getRawText(blockId)
    const nextRawText = rawText.replace(/^>\s?/, '')
    if (nextRawText === rawText) return false

    return this.applyBlockRawCommand(blockId, nextRawText, Math.max(0, this.doc.prefixOffset(blockId) - 1))
  }

  promoteHeadingLevel(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'heading') return false

    const heading = block as HeadingBlock
    if (heading.headingDepth <= 1) return false

    const rawText = this.doc.getRawText(blockId)
    const nextRawText = rawText.replace(/^#{2,6}(?=\s)/, '#'.repeat(heading.headingDepth - 1))
    if (nextRawText === rawText) return false

    return this.applyBlockRawCommand(blockId, nextRawText, Math.max(0, this.doc.prefixOffset(blockId) - 1))
  }

  demoteHeadingLevel(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'heading') return false

    const heading = block as HeadingBlock
    if (heading.headingDepth >= 6) return false

    const rawText = this.doc.getRawText(blockId)
    const nextRawText = rawText.replace(/^#{1,5}(?=\s)/, '#'.repeat(heading.headingDepth + 1))
    if (nextRawText === rawText) return false

    return this.applyBlockRawCommand(blockId, nextRawText, this.doc.prefixOffset(blockId) + 1)
  }

  setCodeBlockLanguage(blockId: string, language: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'code-block') return false

    const codeBlock = block as CodeBlock
    const normalizedLanguage = language.trim().replace(/\s+/g, '')
    if (normalizedLanguage === codeBlock.language) return false

    const rawText = this.doc.getRawText(blockId)
    const fence = codeBlock.fence ?? '```'
    const nextOpeningLine = `${fence}${normalizedLanguage}`
    const nextRawText = rawText.replace(/^[^\n]*/, nextOpeningLine)
    const cursorRawOffset = Math.min(nextRawText.length, nextOpeningLine.length + 1)

    return this.applyBlockRawCommand(blockId, nextRawText, cursorRawOffset)
  }

  setCodeBlockFence(blockId: string, fence: '```' | '~~~'): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'code-block') return false

    const codeBlock = block as CodeBlock
    if (codeBlock.fence === fence) return false

    const rawText = this.doc.getRawText(blockId)
    const lines = rawText.split('\n')
    if (lines.length < 2) return false

    lines[0] = `${fence}${codeBlock.language}`
    lines[lines.length - 1] = fence

    return this.applyBlockRawCommand(blockId, lines.join('\n'), this.doc.prefixOffset(blockId))
  }

  insertTableRowAfter(blockId: string, rowIndex?: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    const columnCount = Math.max(1, table.headers.length)
    const insertAfterIndex = rowIndex ?? table.rows.length - 1
    if (!Number.isInteger(insertAfterIndex) || insertAfterIndex < -1 || insertAfterIndex >= table.rows.length) return false

    const rows = table.rows.map(row => {
      const normalizedRow = row.slice(0, columnCount)
      while (normalizedRow.length < columnCount) normalizedRow.push('')
      return normalizedRow
    })
    rows.splice(insertAfterIndex + 1, 0, Array.from({ length: columnCount }, () => ''))
    const nextRawText = this.buildTableRaw(table.headers, table.aligns, rows)
    const rowStartOffset = this.getTableRowRawOffset(table.headers, table.aligns, rows, insertAfterIndex + 1)

    return this.applyBlockRawCommand(blockId, nextRawText, rowStartOffset + 2)
  }

  insertTableColumnAfter(blockId: string, columnIndex?: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    const insertAfterIndex = columnIndex ?? table.headers.length - 1
    if (!Number.isInteger(insertAfterIndex) || insertAfterIndex < 0 || insertAfterIndex >= table.headers.length) return false

    const insertAt = insertAfterIndex + 1
    const headers = [...table.headers]
    headers.splice(insertAt, 0, '')
    const aligns = [...table.aligns]
    while (aligns.length < table.headers.length) aligns.push('default')
    aligns.splice(insertAt, 0, 'default')
    const rows = table.rows.map(row => {
      const normalizedRow = row.slice(0, table.headers.length)
      while (normalizedRow.length < table.headers.length) normalizedRow.push('')
      normalizedRow.splice(insertAt, 0, '')
      return normalizedRow
    })
    const nextRawText = this.buildTableRaw(headers, aligns, rows)
    const firstCellOffset = this.getTableCellRawOffset(headers, insertAt)

    return this.applyBlockRawCommand(blockId, nextRawText, firstCellOffset)
  }

  duplicateTableRowAfter(blockId: string, rowIndex: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= table.rows.length) return false

    const columnCount = Math.max(1, table.headers.length)
    const rows = table.rows.map(row => {
      const normalizedRow = row.slice(0, columnCount)
      while (normalizedRow.length < columnCount) normalizedRow.push('')
      return normalizedRow
    })
    rows.splice(rowIndex + 1, 0, [...rows[rowIndex]])
    const nextRawText = this.buildTableRaw(table.headers, table.aligns, rows)
    const rowStartOffset = this.getTableRowRawOffset(table.headers, table.aligns, rows, rowIndex + 1)

    return this.applyBlockRawCommand(blockId, nextRawText, rowStartOffset + 2)
  }

  duplicateTableColumnAfter(blockId: string, columnIndex: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= table.headers.length) return false

    const insertAt = columnIndex + 1
    const headers = [...table.headers]
    headers.splice(insertAt, 0, table.headers[columnIndex] ?? '')

    const aligns = [...table.aligns]
    while (aligns.length < table.headers.length) aligns.push('default')
    aligns.splice(insertAt, 0, aligns[columnIndex] ?? 'default')

    const rows = table.rows.map(row => {
      const normalizedRow = row.slice(0, table.headers.length)
      while (normalizedRow.length < table.headers.length) normalizedRow.push('')
      normalizedRow.splice(insertAt, 0, normalizedRow[columnIndex] ?? '')
      return normalizedRow
    })
    const nextRawText = this.buildTableRaw(headers, aligns, rows)
    const firstCellOffset = this.getTableCellRawOffset(headers, insertAt)

    return this.applyBlockRawCommand(blockId, nextRawText, firstCellOffset)
  }

  clearTableRow(blockId: string, rowIndex: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= table.rows.length) return false

    const columnCount = Math.max(1, table.headers.length)
    const rows = table.rows.map(row => {
      const normalizedRow = row.slice(0, columnCount)
      while (normalizedRow.length < columnCount) normalizedRow.push('')
      return normalizedRow
    })
    if (rows[rowIndex].every(cell => cell === '')) return false

    rows[rowIndex] = Array.from({ length: columnCount }, () => '')
    const nextRawText = this.buildTableRaw(table.headers, table.aligns, rows)
    const rowStartOffset = this.getTableRowRawOffset(table.headers, table.aligns, rows, rowIndex)

    return this.applyBlockRawCommand(blockId, nextRawText, rowStartOffset + 2)
  }

  clearTableColumn(blockId: string, columnIndex: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= table.headers.length) return false

    const rows = table.rows.map(row => {
      const normalizedRow = row.slice(0, table.headers.length)
      while (normalizedRow.length < table.headers.length) normalizedRow.push('')
      return normalizedRow
    })
    if (rows.length === 0 || rows.every(row => (row[columnIndex] ?? '') === '')) return false

    rows.forEach(row => {
      row[columnIndex] = ''
    })
    const nextRawText = this.buildTableRaw(table.headers, table.aligns, rows)
    const firstCellOffset = this.getTableCellRawOffset(table.headers, columnIndex)

    return this.applyBlockRawCommand(blockId, nextRawText, firstCellOffset)
  }

  deleteTableLastRow(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    return this.deleteTableRow(blockId, table.rows.length - 1)
  }

  deleteTableRow(blockId: string, rowIndex: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (table.rows.length === 0) return false
    if (!Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= table.rows.length) return false

    const rows = table.rows.filter((_, index) => index !== rowIndex)
    const nextRawText = this.buildTableRaw(table.headers, table.aligns, rows)
    const focusRowIndex = Math.min(rowIndex, rows.length - 1)
    const focusOffset = focusRowIndex >= 0
      ? this.getTableRowRawOffset(table.headers, table.aligns, rows, focusRowIndex) + 2
      : nextRawText.length

    return this.applyBlockRawCommand(blockId, nextRawText, focusOffset)
  }

  deleteTableLastColumn(blockId: string): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    return this.deleteTableColumn(blockId, table.headers.length - 1)
  }

  deleteTableColumn(blockId: string, columnIndex: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (table.headers.length <= 1) return false
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= table.headers.length) return false

    const headers = table.headers.filter((_, index) => index !== columnIndex)
    const aligns = table.aligns
      .slice(0, table.headers.length)
      .filter((_, index) => index !== columnIndex)
    const rows = table.rows.map(row => {
      const normalizedRow = row.slice(0, table.headers.length)
      while (normalizedRow.length < table.headers.length) normalizedRow.push('')
      return normalizedRow.filter((_, index) => index !== columnIndex)
    })
    const nextRawText = this.buildTableRaw(headers, aligns, rows)
    const focusColumnIndex = Math.min(columnIndex, headers.length - 1)
    const firstCellOffset = this.getTableCellRawOffset(headers, focusColumnIndex)

    return this.applyBlockRawCommand(blockId, nextRawText, firstCellOffset)
  }

  setTableColumnAlignment(blockId: string, columnIndex: number, alignment: TableAlignmentTarget): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (!Number.isInteger(columnIndex) || columnIndex < 0 || columnIndex >= table.headers.length) return false
    if ((table.aligns[columnIndex] ?? 'default') === alignment) return false

    const aligns = [...table.aligns]
    while (aligns.length < table.headers.length) aligns.push('default')
    aligns[columnIndex] = alignment

    const nextRawText = this.buildTableRaw(table.headers, aligns, table.rows)
    const separatorOffset = nextRawText.split('\n', 1)[0].length + 1
    return this.applyBlockRawCommand(blockId, nextRawText, separatorOffset)
  }

  setTableAllColumnsAlignment(blockId: string, alignment: TableAlignmentTarget): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'table') return false

    const table = block as TableBlock
    if (table.headers.length === 0) return false
    if (table.headers.every((_, index) => (table.aligns[index] ?? 'default') === alignment)) return false

    const aligns = table.headers.map(() => alignment)
    const nextRawText = this.buildTableRaw(table.headers, aligns, table.rows)
    const separatorOffset = nextRawText.split('\n', 1)[0].length + 1
    return this.applyBlockRawCommand(blockId, nextRawText, separatorOffset)
  }

  convertTextBlock(blockId: string, target: TextBlockConversionTarget): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block) return false

    const contentRaw = this.getConvertibleBlockContentRaw(blockId)
    if (contentRaw === null) return false

    const nextRawText = this.buildConvertedTextBlockRaw(contentRaw, target)
    if (nextRawText === null) return false
    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const effect = this.doc.reconcileFromRawText(blockId, nextRawText)
    if (!effect || effect.kind === 'code-block-degrade') return false

    const targetBlock = effect.kind === 'block-transform' ? effect.to : effect.block
    this.rebuildAndFocusBlock(targetBlock.id, this.doc.prefixOffset(targetBlock.id))
    this.notifyContentChange()
    return true
  }

  private applyBlockRawCommand(blockId: string, nextRawText: string, cursorRawOffset: number): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block) return false

    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const effect = this.doc.reconcileFromRawText(blockId, nextRawText)
    if (!effect || effect.kind === 'code-block-degrade') return false

    const targetBlock = effect.kind === 'block-transform' ? effect.to : effect.block
    this.rebuildAndFocusBlock(targetBlock.id, cursorRawOffset)
    this.notifyContentChange()
    return true
  }

  private moveBlock(blockId: string, direction: 'up' | 'down'): boolean {
    const block = this.doc.getBlock(blockId)
    if (!block) return false

    const targetId = direction === 'up'
      ? this.doc.getPreviousBlockId(blockId)
      : this.doc.getNextBlockId(blockId)
    if (!targetId) return false

    const cursorInfo = this.getCurrentCursorInfo(this.controller['captureSelection']?.() ?? null)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    if (!this.doc.moveBlock(blockId, direction)) return false

    this.dom.fullRebuild(Array.from(this.doc.getBlocks().values()))
    this.rebuildAndFocusBlock(blockId, this.doc.prefixOffset(blockId))
    this.notifyContentChange()
    return true
  }

  /**
   * 获取当前非折叠选区内行内格式状态。
   * active 表示选区全部处于该格式，inactive 表示全部不处于该格式，
   * mixed 表示选区内部存在格式差异，调用方应视为歧义状态。
   */
  getSelectionInlineFormatState(): InlineFormatState | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !sel.anchorNode || !sel.focusNode) return null
    if (!this.view.area.contains(sel.anchorNode) || !this.view.area.contains(sel.focusNode)) return null

    const anchorBlockId = getIdFromBlock(sel.anchorNode)
    const focusBlockId = getIdFromBlock(sel.focusNode)
    if (!anchorBlockId || !focusBlockId) return null
    if (anchorBlockId !== focusBlockId) return createMixedInlineFormatState()

    const block = this.doc.getBlock(anchorBlockId)
    const blockEl = this.dom.getNodeById(anchorBlockId)
    if (!block || !blockEl || !block.inline) return createMixedInlineFormatState()

    if (this.dom.getExpandedBlockId() === anchorBlockId) {
      const range = getSelectionRawRange(blockEl, {
        anchorNode: sel.anchorNode,
        anchorOffset: sel.anchorOffset,
        focusNode: sel.focusNode,
        focusOffset: sel.focusOffset,
        isCollapsed: sel.isCollapsed
      })
      if (!range || range.start === range.end) return null

      return getInlineFormatStateForRawRange(block.inline, range.start, range.end)
    }

    const prefixOffset = this.doc.prefixOffset(anchorBlockId)
    const anchorOffset = computeSemanticOffset(blockEl, sel.anchorNode, sel.anchorOffset, prefixOffset)
    const focusOffset = computeSemanticOffset(blockEl, sel.focusNode, sel.focusOffset, prefixOffset)
    if (anchorOffset === null || focusOffset === null) return createMixedInlineFormatState()

    const start = Math.max(0, Math.min(anchorOffset, focusOffset) - prefixOffset)
    const end = Math.max(0, Math.max(anchorOffset, focusOffset) - prefixOffset)
    if (start === end) return null

    return getInlineFormatStateForRange(block.inline, start, end)
  }

  /**
   * 执行格式化操作（内部方法）
   * 获取当前选区并调用 handleFormatToggle
   */
  private executeFormat(format: string): void {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return
    if (!this.view.area.contains(sel.anchorNode)) return

    const selection: SelectionSnapshot = {
      anchorNode: sel.anchorNode,
      anchorOffset: sel.anchorOffset,
      focusNode: sel.focusNode,
      focusOffset: sel.focusOffset,
      isCollapsed: sel.isCollapsed
    }

    // 保存快照用于 Undo
    const cursorInfo = this.getCurrentCursorInfo(selection)
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    this.handleFormatToggle(selection, format)
    this.notifyContentChange()
  }

  private rebuildAndFocusBlock(blockId: string, rawOffset: number): void {
    const blocks = Array.from(this.doc.getBlocks().values())
    this.dom.fullRebuild(blocks)
    const block = this.doc.getBlock(blockId)
    if (!block) return

    this.dom.renderBlockExpanded(block)
    this.dom.setCursorByRawOffset(blockId, rawOffset)
    this.dom.clearHighlight()
    this.scheduler.highlightBlock(blockId, BlockVisualState.active)
    this.skipNextSelectionAction = true
  }

  private getConvertibleBlockContentRaw(blockId: string): string | null {
    const block = this.doc.getBlock(blockId)
    if (!block) return null
    if (block.type === 'code-block' || block.type === 'math-block' || block.type === 'table' || block.type === 'hr') return null
    if ('footnoteId' in block) return null

    const rawText = this.doc.getRawText(blockId)
    if (block.type === 'blank') return ''
    return rawText.slice(this.doc.prefixOffset(blockId))
  }

  private buildConvertedTextBlockRaw(contentRaw: string, target: TextBlockConversionTarget): string | null {
    if (target === 'paragraph') return contentRaw
    if (target === 'heading-1') return `# ${contentRaw}`
    if (target === 'heading-2') return `## ${contentRaw}`
    if (target === 'heading-3') return `### ${contentRaw}`
    if (target === 'unordered-list') return `- ${contentRaw}`
    if (target === 'ordered-list') return `1. ${contentRaw}`
    if (target === 'blockquote') return `> ${contentRaw}`
    return null
  }

  private getBlockTemplateDetails(template: BlockTemplateTarget): { rawText: string; cursorRawOffset: number } | null {
    if (template === 'paragraph') {
      return { rawText: '', cursorRawOffset: 0 }
    }
    if (template === 'task-list') {
      return { rawText: '- [ ] ', cursorRawOffset: 6 }
    }
    if (template === 'code-block') {
      return { rawText: '```\n\n```', cursorRawOffset: 4 }
    }
    if (template === 'math-block') {
      return { rawText: '$$\n\n$$', cursorRawOffset: 3 }
    }
    if (template === 'table') {
      return { rawText: '|  |  |\n| --- | --- |\n|  |  |', cursorRawOffset: 2 }
    }
    return null
  }

  private buildTableRaw(
    headers: string[],
    aligns: TableAlignmentTarget[],
    rows: string[][]
  ): string {
    const headerRow = `| ${headers.join(' | ')} |`
    const separatorRow = `| ${headers.map((_, index) => {
      const align = aligns[index] ?? 'default'
      if (align === 'left') return ':---'
      if (align === 'center') return ':---:'
      if (align === 'right') return '---:'
      return '---'
    }).join(' | ')} |`
    const dataRows = rows.map(row => `| ${headers.map((_, index) => row[index] ?? '').join(' | ')} |`)
    return [headerRow, separatorRow, ...dataRows].join('\n')
  }

  private getTableCellRawOffset(headers: string[], columnIndex: number): number {
    const boundedIndex = Math.max(0, Math.min(columnIndex, headers.length - 1))
    let offset = 2
    for (let index = 0; index < boundedIndex; index += 1) {
      offset += headers[index].length + 3
    }
    return offset
  }

  private getTableRowRawOffset(headers: string[], aligns: TableAlignmentTarget[], rows: string[][], rowIndex: number): number {
    const boundedIndex = Math.max(0, Math.min(rowIndex, rows.length - 1))
    const headerRow = `| ${headers.join(' | ')} |`
    const separatorRow = `| ${headers.map((_, index) => {
      const align = aligns[index] ?? 'default'
      if (align === 'left') return ':---'
      if (align === 'center') return ':---:'
      if (align === 'right') return '---:'
      return '---'
    }).join(' | ')} |`
    let offset = headerRow.length + 1 + separatorRow.length + 1
    for (let index = 0; index < boundedIndex; index += 1) {
      const row = rows[index]
      offset += `| ${headers.map((_, columnIndex) => row[columnIndex] ?? '').join(' | ')} |`.length + 1
    }
    return offset
  }

  /**
   * 获取当前选区中的文本内容
   * 将原生选区映射到源码范围，保留跨 Block 的原始换行和标记符。
   */

  private getSelectedText(selection: SelectionSnapshot): string | null {
    const cursor = this.getCurrentCursorInfo(selection)
    if (!cursor || selection.isCollapsed || cursor.sourceOffset === undefined || cursor.headSourceOffset === undefined) return null
    return this.doc.getSource().slice(
      Math.min(cursor.sourceOffset, cursor.headSourceOffset),
      Math.max(cursor.sourceOffset, cursor.headSourceOffset)
    )
  }

  /**
   * 获取两个 block 之间（包含两端）的所有 block ID，按 DOM 顺序排列
   */
  private getBlockIdsBetween(startId: string, endId: string): string[] {
    const blockIds = Array.from(this.doc.getBlocks().keys())
    const startIdx = blockIds.indexOf(startId)
    const endIdx = blockIds.indexOf(endId)
    if (startIdx === -1 || endIdx === -1) return []

    const from = Math.min(startIdx, endIdx)
    const to = Math.max(startIdx, endIdx)
    return blockIds.slice(from, to + 1)
  }

  /**
   * 获取当前光标位置信息（blockId + 偏移量）
   * 用于 Undo/Redo 快照中保存光标状态
   */
  private getCurrentCursorInfo(selection: SelectionSnapshot | null): CursorInfo | null {
    if (!selection?.anchorNode) return null


    const resolveDOMPoint = (node: Node | null, domOffset: number) => {
      if (!node || !this.view.area.contains(node)) return null
      if (node === this.view.area) {
        const child = this.view.area.childNodes[domOffset] as HTMLElement | undefined
        const blockId = child?.dataset?.blockId
        const range = blockId ? this.doc.getSourceRange(blockId) : null
        const sourceOffset = range?.from ?? this.doc.getSource().length
        const location = this.doc.resolveSourceOffset(sourceOffset)
        return location ? { ...location, sourceOffset, isExpanded: true } : null
      }
      const blockId = getIdFromBlock(node)
      const root = getBlockAnchor(node)
      const block = this.doc.getBlock(blockId)
      if (!root || !block) return null
      const raw = this.doc.getRawText(blockId)
      const isExpanded = root.classList.contains('md-block-expanded')
      const semantic = isExpanded ? null : computeSemanticOffset(root, node, domOffset, this.doc.prefixOffset(blockId))
      const offset = raw.length === 0 ? 0 : isExpanded
        ? computeRawOffset(root, node, domOffset)
        : semantic === null ? null : this.semanticToRawOffset(block, semantic)
      if (offset === null) return null
      const localOffset = Math.min(offset, raw.length)
      const sourceOffset = this.doc.getSourceOffset(blockId, localOffset)
      if (sourceOffset === null) return null
      return { blockId, localOffset, sourceOffset, isExpanded: true }
    }

    const anchor = resolveDOMPoint(selection.anchorNode, selection.anchorOffset)
    if (!anchor) return null
    const head = selection.isCollapsed
      ? anchor
      : resolveDOMPoint(selection.focusNode, selection.focusOffset)

    return {
      blockId: anchor.blockId,
      offset: anchor.localOffset,
      isRawOffset: anchor.isExpanded,
      sourceOffset: anchor.sourceOffset,
      headSourceOffset: head?.sourceOffset
    }
  }

  /**
   * 处理在标识符内部的输入
   * 将字符插入到整行原始文本的正确位置，然后全行 reconcile
   */
  private handleInsertInMarker(
    block: BlockModel,
    blockEl: HTMLElement,
    anchorNode: Node,
    anchorOffset: number,
    text: string
  ) {
    // 1. 从源码范围读取整行原始文本
    const rawText = this.doc.getRawText(block.id)
    
    // 2. 计算字符在原始文本中的插入位置
    let rawOffset = computeRawOffset(blockEl, anchorNode, anchorOffset)
    // 空行（blank block）展开后只有零宽空格文本节点，rawOffset 可能是 0 或 1
    // 但 getRawText 返回空字符串，所以强制为 0
    if (rawText.length === 0) {
      rawOffset = 0
    } else if (rawOffset === null) {
      return
    }

    if (block.type === 'code-block' && (block as CodeBlock).code === '') {
      const firstLineBreak = rawText.indexOf('\n')
      const codeLineCount = (block as CodeBlock).codeLineCount ?? 0
      if (firstLineBreak !== -1 && codeLineCount > 0 && rawOffset === firstLineBreak + 1 && rawText[rawOffset] === '\n') {
        const newRawText = rawText.slice(0, rawOffset) + text + rawText.slice(rawOffset)
        this.applyRawReconcile(block, newRawText, rawOffset + text.length)
        return
      }
    }

    // 3. 将字符插入到原始文本中
    const newRawText = rawText.slice(0, rawOffset) + text + rawText.slice(rawOffset)

    if (text === '|' && this.doc.getNextBlockId(block.id) && this.tryRebuildTableAroundBlock(block, rawOffset + text.length, newRawText, 3)) {
      return
    }

    // 4. 全行 reconcile
    this.applyRawReconcile(block, newRawText, rawOffset + text.length)
  }

  /**
   * 通过已知的 raw offset 在标识符内部插入文本（用于 IME 输入）
   */
  private handleInsertInMarkerByRawOffset(
    block: BlockModel,
    blockEl: HTMLElement,
    rawOffset: number,
    text: string
  ) {
    // 1. 从 model 重建整行原始文本
    const rawText = this.doc.getRawText(block.id)
    
    // 2. 将字符插入到原始文本中
    const newRawText = rawText.slice(0, rawOffset) + text + rawText.slice(rawOffset)

    // 3. 全行 reconcile
    this.applyRawReconcile(block, newRawText, rawOffset + text.length)
  }

  /**
   * 处理非空选区的替换操作
   * 先删除选中内容，再插入新文本（text 为空表示纯删除）
   */

  private handleReplaceSelection(block: BlockModel, blockEl: HTMLElement, selection: SelectionSnapshot, text: string) {
    const range = getSelectionRawRange(blockEl, selection)
    if (!range) return
    const raw = this.doc.getRawText(block.id)
    this.applyRawReconcile(block, raw.slice(0, range.start) + text + raw.slice(range.end), range.start + text.length)
  }

  /**
   * 将新的块源码交给统一事务路径，再同步投影、DOM 和光标。
   */

  private applyRawReconcile(block: BlockModel, newRawText: string, cursorRawOffset: number) {
    const range = this.doc.getSourceRange(block.id)
    if (!range) return
    this.applySourceEdit(range, newRawText, range.from + cursorRawOffset, 'keyboard', block.id)
  }

  private getSoftLineBreakText(offset: number): string {
    const source = this.doc.getSource()
    const lineStart = offset === 0 ? 0 : Math.max(
      source.lastIndexOf('\n', offset - 1), source.lastIndexOf('\r', offset - 1)
    ) + 1
    // Only copy indentation retained before the insertion/selection start.
    // Splitting inside indentation must not duplicate the remaining whitespace.
    const indent = source.slice(lineStart, offset).match(/^[ \t]*/)![0]
    const followingEnding = source.slice(offset).match(/\r\n|\r|\n/)?.[0]
    const precedingEnding = source.slice(Math.max(0, lineStart - 2), lineStart).match(/\r\n|\r|\n/)?.[0]
    return (followingEnding ?? precedingEnding ?? '\n') + indent
  }

  private applySourceEdit(
    range: SourceRange, insert: string, caret: number, origin: EditOrigin, preferredBlockId?: string
  ): void {
    const previous = this.doc.getBlocks()
    preferredBlockId ??= this.doc.resolveSourceOffset(range.from)?.blockId
    if (this.crossBlockExpandRaf !== null) cancelAnimationFrame(this.crossBlockExpandRaf)
    this.crossBlockExpandRaf = null
    this.crossBlockSelection = null
    // Collapse old selection views BEFORE restoring the new caret, never after.
    this.dom.collapseAllMultiExpanded(previous)
    this.doc.applyTransaction({ changes: [{ range, insert }], origin }, preferredBlockId)
    this.dom.reconcileBlocks(this.doc.getBlocks(), previous)
    const location = this.doc.resolveSourceOffset(caret)
    if (!location) return
    const target = this.doc.getBlock(location.blockId)!
    const oldExpanded = this.dom.getExpandedBlockId()
    if (oldExpanded && oldExpanded !== target.id) {
      const oldBlock = this.doc.getBlock(oldExpanded)
      if (oldBlock) this.dom.collapseBlock(oldBlock)
    }
    this.dom.forceResetExpanded()
    this.dom.renderBlockExpanded(target)
    this.dom.setCursorByRawOffset(target.id, location.localOffset)
    this.dom.clearHighlight()
    this.scheduler.highlightBlock(target.id, BlockVisualState.active)
    this.skipNextSelectionAction = true
  }

  private applyRawReconcileAndSelect(
    block: BlockModel,
    newRawText: string,
    selectionStartRawOffset: number,
    selectionEndRawOffset: number
  ) {
    this.applyRawReconcile(block, newRawText, selectionEndRawOffset)
    this.dom.setSelectionByRawOffsets(
      block.id,
      selectionStartRawOffset,
      block.id,
      selectionEndRawOffset
    )
  }

  private exitFencedBlockAfterClosingLine(block: BlockModel, rawText: string, rawOffset: number): boolean {
    if (block.type !== 'code-block' && block.type !== 'math-block') return false

    const closingLineStart = block.type === 'math-block' && (block as MathBlock).singleLine
      ? rawText.lastIndexOf('$$')
      : rawText.lastIndexOf('\n') + 1
    if (closingLineStart <= 0 || rawOffset < closingLineStart) return false

    this.dom.collapseBlock(block)
    this.dom.forceResetExpanded()

    const newBlock = this.doc.createBlockFromRawText('', block.id)
    this.dom.insertBlock(block, newBlock)
    this.dom.renderBlockExpanded(newBlock)
    this.dom.setCursorByRawOffset(newBlock.id, 0)
    this.dom.clearHighlight()
    this.scheduler.highlightBlock(newBlock.id, BlockVisualState.active)
    this.skipNextSelectionAction = true

    return true
  }

  private moveCursorToDocumentEnd(): void {
    const blocks = Array.from(this.doc.getBlocks().values())
    const lastBlock = blocks[blocks.length - 1]
    if (!lastBlock) return

    const expandedBlockId = this.dom.getExpandedBlockId()
    if (expandedBlockId && expandedBlockId !== lastBlock.id) {
      const expandedBlock = this.doc.getBlock(expandedBlockId)
      if (expandedBlock) this.dom.collapseBlock(expandedBlock)
    }

    this.dom.forceResetExpanded()
    this.dom.renderBlockExpanded(lastBlock)
    this.dom.setCursorByRawOffset(lastBlock.id, this.doc.getRawText(lastBlock.id).length)
    this.dom.clearHighlight()
    this.scheduler.highlightBlock(lastBlock.id, BlockVisualState.active)
    this.skipNextSelectionAction = true
  }

  private replaceBlockWithBlank(block: BlockModel): BlockModel {
    this.doc.reconcileFromRawText(block.id, '')
    return this.doc.getBlock(block.id) ?? {
      id: block.id,
      type: 'blank',
      inline: []
    }
  }

  private handleCodeBlockMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return

    const target = event.target as HTMLElement | null
    const codeEl = target?.closest('.md-code-block')
    if (!codeEl || !this.view.area.contains(codeEl)) return

    const blockEl = codeEl.closest('.md-line-block') as HTMLElement | null
    const blockId = blockEl?.dataset.blockId
    const block = blockId ? this.doc.getBlock(blockId) : undefined
    if (!block || block.type !== 'code-block') return
    if (this.dom.getExpandedBlockId() === block.id) return

    event.preventDefault()

    this.dom.expandBlock(block.id, block)
    this.dom.clearHighlight()
    this.scheduler.highlightBlock(block.id, BlockVisualState.active)
    this.skipNextSelectionAction = true
  }

  private handleBlockMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return

    const target = event.target as HTMLElement | null
    const blockEl = target?.closest('.md-line-block') as HTMLElement | null
    const clickedBlockId = blockEl?.dataset.blockId
    const expandedBlockId = this.dom.getExpandedBlockId()
    if (clickedBlockId && !event.shiftKey && this.doc.getRawText(clickedBlockId) === '') {
      const blank = this.doc.getBlock(clickedBlockId)
      if (!blank) return
      event.preventDefault()
      if (expandedBlockId && expandedBlockId !== clickedBlockId) {
        const previous = this.doc.getBlock(expandedBlockId)
        if (previous) this.dom.collapseBlock(previous)
      }
      this.view.area.focus()
      this.dom.renderBlockExpanded(blank)
      this.dom.setCursorByRawOffset(clickedBlockId, 0)
      return
    }
    if (!clickedBlockId || !expandedBlockId || clickedBlockId === expandedBlockId) return

    const expandedBlock = this.doc.getBlock(expandedBlockId)
    if (expandedBlock) {
      this.dom.collapseBlock(expandedBlock)
    }
  }

  private tryHandleMarkdownAutoComplete(
    block: BlockModel,
    root: HTMLElement,
    selection: SelectionSnapshot,
    data: string,
    isExpanded: boolean
  ): boolean {
    if (!selection.isCollapsed || data.length !== 1) return false
    if (block.type === 'code-block' || block.type === 'math-block') return false

    const rawText = this.doc.getRawText(block.id)
    let rawOffset: number | null

    if (rawText.length === 0) {
      rawOffset = 0
    } else if (isExpanded) {
      rawOffset = computeRawOffset(root, selection.anchorNode!, selection.anchorOffset)
    } else {
      rawOffset = computeSemanticOffset(root, selection.anchorNode!, selection.anchorOffset, this.doc.prefixOffset(block.id))
    }

    if (rawOffset === null) return false

    if (data === '`') {
      const lineStart = rawText.lastIndexOf('\n', rawOffset - 1) + 1
      const lineBeforeCursor = rawText.slice(lineStart, rawOffset)
      const fenceIndent = lineBeforeCursor.match(/^(\s*)``$/)?.[1]

      if (fenceIndent !== undefined && !isEscaped(rawText, rawOffset - 2)) {
        const currentFenceRawText = rawText.slice(0, rawOffset) + data + rawText.slice(rawOffset)
        if (this.tryRebuildCodeBlockAroundFence(block, currentFenceRawText, rawOffset + data.length)) {
          return true
        }

        const insertion = `${fenceIndent}\`\`\`\n${fenceIndent}\`\`\``
        const newRawText = rawText.slice(0, lineStart) + insertion + rawText.slice(rawOffset)
        this.applyRawReconcile(block, newRawText, lineStart + fenceIndent.length + 3)
        return true
      }

      if (rawText[rawOffset] === '`' && !isEscaped(rawText, rawOffset)) {
        this.dom.setCursorByRawOffset(block.id, rawOffset + 1)
        return true
      }
    }

    // 输入 $ 时的自动补全
    if (data === '$') {
      const lineStart = rawText.lastIndexOf('\n', rawOffset - 1) + 1
      const lineEnd = rawText.indexOf('\n', rawOffset)
      const lineBeforeCursor = rawText.slice(lineStart, rawOffset)
      const lineAfterCursor = rawText.slice(rawOffset, lineEnd === -1 ? undefined : lineEnd)

      // 检测是否形成 $$（块级公式）：光标前是行首空白+$，且光标后到行尾只有 $ 或为空
      // 即整行将变成 $$，独占一行
      const mathFenceIndent = lineBeforeCursor.match(/^(\s*)\$$/)?.[1]
      if (mathFenceIndent !== undefined && !isEscaped(rawText, rawOffset - 1)
        && (lineAfterCursor === '' || lineAfterCursor === '$')) {
        const afterOffset = lineAfterCursor === '$' ? rawOffset + 1 : rawOffset
        const currentFenceRawText = rawText.slice(0, lineStart) + `${mathFenceIndent}$$` + rawText.slice(afterOffset)
        if (this.tryRebuildMathBlockAroundFence(block, currentFenceRawText)) {
          return true
        }
        // 没有相邻 fence 可合并时，生成 $$\n\n$$ 空公式块
        const insertion = `${mathFenceIndent}$$\n${mathFenceIndent}\n${mathFenceIndent}$$`
        const newRawText = rawText.slice(0, lineStart) + insertion + rawText.slice(afterOffset)
        this.applyRawReconcile(block, newRawText, lineStart + mathFenceIndent.length + 2 + 1)
        return true
      }

      // 破坏 math-block 围栏后会得到一个空行和另一侧的 $$。
      // 此时第一个 $ 必须作为真实 opener 写入源码，等第二个 $ 到来再把
      // 整个范围恢复成 math-block；若立即补成行内 $$，第二次键入会多出一个 $。
      const hasOtherMathFence = rawText.trim() === '' && Array.from(this.doc.blocks.keys())
        .some(id => id !== block.id && this.doc.getRawText(id).trim() === '$$')
      if (hasOtherMathFence) {
        const newRawText = rawText.slice(0, rawOffset) + '$' + rawText.slice(rawOffset)
        this.applyRawReconcile(block, newRawText, rawOffset + 1)
        return true
      }

      // 光标后面已有 $，跳过（避免重复插入）
      if (rawText[rawOffset] === '$' && !isEscaped(rawText, rawOffset)) {
        this.dom.setCursorByRawOffset(block.id, rawOffset + 1)
        return true
      }

      // 行内公式：手动插入配对的 $$
      if (!isEscaped(rawText, rawOffset)) {
        const newRawText = rawText.slice(0, rawOffset) + '$$' + rawText.slice(rawOffset)
        this.applyRawReconcile(block, newRawText, rawOffset + 1)
        return true
      }
    }

    if (!isAutoPairCharacter(data) || isEscaped(rawText, rawOffset)) return false

    const marker = data as CompletionSession['marker']
    const newRawText = rawText.slice(0, rawOffset) + marker + rawText.slice(rawOffset)
    this.applyRawReconcile(block, newRawText, rawOffset + 1)
    this.completionSession = {
      blockId: block.id,
      marker,
      openerStart: rawOffset,
      openerLength: 1
    }
    this.dom.showCompletionDecoration(block.id, rawOffset + 1, marker)
    return true
  }

  private tryHandleCompletionSession(
    block: BlockModel,
    root: HTMLElement,
    selection: SelectionSnapshot,
    data: string,
    isExpanded: boolean
  ): boolean {
    const session = this.completionSession
    if (!session) return false
    if (
      session.blockId !== block.id ||
      !selection.isCollapsed ||
      !isAutoPairCharacter(session.marker)
    ) {
      this.cancelCompletionSession()
      return false
    }

    const rawOffset = isExpanded
      ? computeRawOffset(root, selection.anchorNode!, selection.anchorOffset)
      : computeSemanticOffset(root, selection.anchorNode!, selection.anchorOffset, this.doc.prefixOffset(block.id))
    const expectedOffset = session.openerStart + session.openerLength
    if (rawOffset !== expectedOffset) {
      this.cancelCompletionSession()
      return false
    }

    const rawText = this.doc.getRawText(block.id)
    if (data === session.marker && session.openerLength < 2) {
      const nextLength = session.openerLength + 1
      const nextRaw = rawText.slice(0, rawOffset) + data + rawText.slice(rawOffset)
      this.applyRawReconcile(block, nextRaw, rawOffset + 1)
      this.completionSession = { ...session, openerLength: nextLength }
      this.dom.showCompletionDecoration(block.id, rawOffset + 1, session.marker.repeat(nextLength))
      return true
    }

    if (data === '`' && session.marker === '`' && session.openerLength === 2) {
      const nextRaw = rawText.slice(0, rawOffset) + data + rawText.slice(rawOffset)
      this.cancelCompletionSession()
      this.applyRawReconcile(block, nextRaw, rawOffset + 1)
      return true
    }

    if (data === '') return true

    // A space after a line-leading star selects list syntax, not emphasis.
    if (session.marker === '*' && session.openerLength === 1 && /^[ \t]+$/.test(data) &&
        /^[ \t]*$/.test(rawText.slice(0, session.openerStart))) {
      this.cancelCompletionSession()
      return false
    }

    const closer = session.marker.repeat(session.openerLength)
    const nextRaw = rawText.slice(0, rawOffset) + data + closer + rawText.slice(rawOffset)
    this.completionSession = null
    this.dom.clearCompletionDecoration()
    this.applyRawReconcile(block, nextRaw, rawOffset + data.length)
    return true
  }

  private validateCompletionSelection(selection: SelectionSnapshot | null): void {
    const session = this.completionSession
    if (!session || !selection?.isCollapsed || !selection.anchorNode) {
      this.cancelCompletionSession()
      return
    }
    if (getIdFromBlock(selection.anchorNode) !== session.blockId) {
      this.cancelCompletionSession()
      return
    }
    const blockEl = this.dom.getNodeById(session.blockId)
    if (!blockEl) {
      this.cancelCompletionSession()
      return
    }
    const offset = computeRawOffset(blockEl, selection.anchorNode, selection.anchorOffset)
    if (offset !== session.openerStart + session.openerLength) {
      this.cancelCompletionSession()
    }
  }

  private cancelCompletionSession(): void {
    this.completionSession = null
    this.dom.clearCompletionDecoration()
  }

  private tryRebuildMathBlockAroundFence(block: BlockModel, currentRawText: string): boolean {
    if (currentRawText.trim() !== '$$') return false

    const ids = Array.from(this.doc.blocks.keys())
    const currentIdx = ids.indexOf(block.id)
    if (currentIdx === -1) return false

    const raws = ids.map(id => id === block.id ? currentRawText : this.doc.getRawText(id))
    const overrides = new Map([[block.id, currentRawText]])

    const tryApplyRange = (startIdx: number, endIdx: number, cursorRawOffset: number): boolean => {
      if (startIdx < 0 || endIdx >= ids.length || startIdx >= endIdx) return false

      const candidate = this.doc.getRawTextForBlockRange(ids[startIdx], ids[endIdx], overrides)
      if (candidate === null) return false

      const startBlock = this.doc.getBlock(ids[startIdx])
      if (!startBlock) return false

      const previewBlocks = this.doc.parseBlocksFromRawText(candidate, ids[startIdx])
      if (previewBlocks.length !== 1 || previewBlocks[0].type !== 'math-block') return false

      const result = this.doc.replaceBlockRangeFromRawText(ids[startIdx], ids[endIdx], candidate)
      if (!result || result.blocks.length !== 1 || result.blocks[0].type !== 'math-block') return false

      for (const removedId of result.removedBlockIds) {
        this.dom.removeBlockNode(removedId)
      }

      const mathBlock = result.blocks[0]
      this.dom.replaceBlock(startBlock, mathBlock)
      this.dom.forceResetExpanded()
      this.dom.renderBlockExpanded(mathBlock)
      this.dom.setCursorByRawOffset(mathBlock.id, cursorRawOffset)
      this.dom.clearHighlight()
      this.scheduler.highlightBlock(mathBlock.id, BlockVisualState.active)
      this.skipNextSelectionAction = true
      return true
    }

    for (let startIdx = currentIdx - 1; startIdx >= 0; startIdx--) {
      if (raws[startIdx].trim() !== '$$') continue
      const cursorOffset = this.doc.getRawOffsetWithinBlockRange(
        ids[startIdx],
        block.id,
        currentRawText.length
      )
      if (cursorOffset !== null && tryApplyRange(startIdx, currentIdx, cursorOffset)) {
        return true
      }
    }

    for (let endIdx = currentIdx + 1; endIdx < ids.length; endIdx++) {
      if (raws[endIdx].trim() !== '$$') continue
      if (tryApplyRange(currentIdx, endIdx, currentRawText.length)) {
        return true
      }
    }

    return false
  }

  private tryRebuildCodeBlockAroundFence(block: BlockModel, currentRawText: string, currentCursorOffset: number): boolean {
    if (!/^(`{3,}|~{3,})[ \t]*.*$/.test(currentRawText)) return false

    const ids = Array.from(this.doc.blocks.keys())
    const currentIdx = ids.indexOf(block.id)
    if (currentIdx === -1) return false

    const raws = ids.map(id => id === block.id ? currentRawText : this.doc.getRawText(id))
    const overrides = new Map([[block.id, currentRawText]])

    const tryApplyRange = (startIdx: number, endIdx: number): boolean => {
      if (startIdx < 0 || endIdx >= ids.length || startIdx >= endIdx) return false

      const candidate = this.doc.getRawTextForBlockRange(ids[startIdx], ids[endIdx], overrides)
      if (candidate === null) return false
      const tokens = initialTokenize(candidate)
      if (tokens.length !== 1) return false

      const parsed = parseLine(tokens[0])
      if (parsed.type !== 'code-block') return false

      const startBlock = this.doc.getBlock(ids[startIdx])
      if (!startBlock) return false

      const result = this.doc.replaceBlockRangeFromRawText(ids[startIdx], ids[endIdx], candidate)
      if (!result || result.blocks.length !== 1) return false

      for (const removedId of result.removedBlockIds) {
        this.dom.removeBlockNode(removedId)
      }

      const cursorRawOffset = this.doc.getRawOffsetWithinBlockRange(
        ids[startIdx],
        block.id,
        currentCursorOffset
      )
      if (cursorRawOffset === null) return false
      const codeBlock = result.blocks[0]
      this.dom.replaceBlock(startBlock, codeBlock)
      this.dom.forceResetExpanded()
      this.dom.renderBlockExpanded(codeBlock)
      this.dom.setCursorByRawOffset(codeBlock.id, cursorRawOffset)
      this.dom.clearHighlight()
      this.scheduler.highlightBlock(codeBlock.id, BlockVisualState.active)
      this.skipNextSelectionAction = true
      return true
    }

    for (let startIdx = currentIdx - 1; startIdx >= 0; startIdx--) {
      if (tryApplyRange(startIdx, currentIdx)) return true
    }

    for (let endIdx = currentIdx + 1; endIdx < ids.length; endIdx++) {
      if (tryApplyRange(currentIdx, endIdx)) return true
    }

    return false
  }

  private tryRebuildTableAroundBlock(block: BlockModel, cursorRawOffset: number, currentRawText?: string, minLineCount: number = 2): boolean {
    const ids = Array.from(this.doc.blocks.keys())
    const currentIdx = ids.indexOf(block.id)
    if (currentIdx === -1) return false

    const raws = ids.map(id => id === block.id ? (currentRawText ?? this.doc.getRawText(id)) : this.doc.getRawText(id))
    const overrides = currentRawText === undefined
      ? new Map<string, string>()
      : new Map([[block.id, currentRawText]])

    const tryApplyRange = (startIdx: number, endIdx: number): boolean => {
      if (startIdx < 0 || endIdx >= ids.length || startIdx >= endIdx) return false

      const candidate = this.doc.getRawTextForBlockRange(ids[startIdx], ids[endIdx], overrides)
      if (candidate === null) return false
      if (candidate.split(/\r\n|\r|\n/).length < minLineCount) return false
      const tokens = initialTokenize(candidate)
      if (tokens.length !== 1) return false

      const parsed = parseLine(tokens[0])
      if (parsed.type !== 'table') return false

      const startBlock = this.doc.getBlock(ids[startIdx])
      if (!startBlock) return false

      const result = this.doc.replaceBlockRangeFromRawText(ids[startIdx], ids[endIdx], candidate)
      if (!result || result.blocks.length !== 1 || result.blocks[0].type !== 'table') return false

      for (const removedId of result.removedBlockIds) {
        this.dom.removeBlockNode(removedId)
      }

      const tableBlock = result.blocks[0]
      const tableCursorOffset = this.doc.getRawOffsetWithinBlockRange(
        ids[startIdx],
        block.id,
        cursorRawOffset
      )
      if (tableCursorOffset === null) return false
      this.dom.replaceBlock(startBlock, tableBlock)
      this.dom.forceResetExpanded()
      this.dom.renderBlockExpanded(tableBlock)
      this.dom.setCursorByRawOffset(tableBlock.id, tableCursorOffset)
      this.dom.clearHighlight()
      this.scheduler.highlightBlock(tableBlock.id, BlockVisualState.active)
      this.skipNextSelectionAction = true
      return true
    }

    for (let startIdx = currentIdx - 1; startIdx >= 0; startIdx--) {
      if (tryApplyRange(startIdx, currentIdx)) return true
    }

    for (let startIdx = currentIdx - 1; startIdx >= 0; startIdx--) {
      for (let endIdx = currentIdx + 1; endIdx < ids.length; endIdx++) {
        if (tryApplyRange(startIdx, endIdx)) return true
      }
    }

    return false
  }

  private tryCompleteCodeBlockFromOpeningFence(
    block: BlockModel,
    rawText: string,
    rawOffset: number
  ): boolean {
    if (block.type === 'code-block') return false

    const beforeRaw = rawText.slice(0, rawOffset)
    const afterRaw = rawText.slice(rawOffset)
    const openingFence = parseOpeningCodeFence(beforeRaw)
    if (!openingFence) return false

    const closingFence = afterRaw.length > 0 ? parseClosingCodeFence(afterRaw) : null
    if (afterRaw.length > 0 && closingFence !== openingFence.marker) return false

    const newRawText = beforeRaw + '\n\n' + (closingFence ?? openingFence.marker)
    this.applyRawReconcile(block, newRawText, beforeRaw.length + 1)
    return true
  }

  handleInput(id: string, blockEl: HTMLDivElement) {
    if (!id) return

    // 1️⃣ 从 DOM 提取“用户当前输入的语义文本”
    const domText = this.view.extractText(blockEl)

    // 2️⃣ 让 DocumentController 做语义 reconcile
    const effect = this.doc.reconcileBlock(id, domText)

    if (!effect) return

    if (effect.kind === 'inline-update') {
      this.dom.updateInline(effect.block!)
      return
    }

    if (effect.kind === 'block-transform') {
      this.applyTransaction({
        type: 'replace-block',
        from: effect.from!,
        to: effect.to!
      })
    }
  }

  applyTransaction(tx: { type: 'replace-block'; from: BlockModel; to: BlockModel }) {
    // The controller already committed the canonical source transaction.
    this.dom.replaceBlock(tx.from, tx.to)
  }

  handleDeleteAtListMarker(markerEl: HTMLElement) {
    const blockEl = markerEl.closest('.md-line-block') as HTMLDivElement
    if (!blockEl) {
      this.isHandlingDelete = false
      return
    }

    const blockId = blockEl.dataset.blockId
    if (!blockId) {
      this.isHandlingDelete = false
      return
    }

    // 1. 拿当前 block model
    const block = this.doc.getBlock(blockId)
    if (!block || block.type !== 'list-item') {
      this.isHandlingDelete = false
      return
    }

    // 2. Delete the list marker from canonical source, then reparse.
    const raw = this.doc.getRawText(blockId)
    const nesting = block.nesting ?? 0
    const nextRaw = raw.slice(0, nesting) + raw.slice(this.doc.prefixOffset(blockId))
    const effect = this.doc.reconcileFromRawText(blockId, nextRaw)
    const nextBlock = effect?.kind === 'block-transform'
      ? effect.to
      : this.doc.getBlock(blockId)
    if (!nextBlock) {
      this.isHandlingDelete = false
      return
    }

    // 3. DOM 更新（交给 DOMController）
    this.dom.replaceBlock(block, nextBlock)

    // 4. 光标恢复（关键）
    // this.restoreCursorAfterListRemoval(blockEl, nextBlock.id)

    this.isHandlingDelete = false
  } 

  /**
   * 处理格式化快捷键（Cmd/Ctrl+B 加粗、+I 斜体等）
   * 逻辑：在选区两端插入/移除对应的 Markdown 标记符
   */
  private handleFormatToggle(selection: SelectionSnapshot | null, format: string) {
    if (!selection || !selection.anchorNode) return

    const blockId = getIdFromBlock(selection.anchorNode)
    const block = this.doc.getBlock(blockId)
    const blockEl = this.dom.getNodeById(blockId)
    if (!block || !blockEl) return

    // 确定标记符
    const markerMap: Record<string, string> = {
      bold: '**',
      italic: '*',
      strikethrough: '~~',
      code: '`',
      highlight: '=='
    }
    const marker = markerMap[format]
    if (!marker && format !== 'link') return

    const isExpanded = this.dom.getExpandedBlockId() === blockId
    const rawText = this.doc.getRawText(blockId)

    if (format === 'link') {
      // 链接格式：[text](url) 或无选区时 [](url)
      if (selection.isCollapsed) {
        // 无选区：插入空链接模板
        let rawOffset: number | null
        if (isExpanded) {
          rawOffset = computeRawOffset(blockEl, selection.anchorNode, selection.anchorOffset)
        } else {
          rawOffset = computeSemanticOffset(blockEl, selection.anchorNode, selection.anchorOffset, this.doc.prefixOffset(blockId))
          if (rawOffset !== null) rawOffset = rawOffset  // semantic offset 已包含 prefix
        }
        if (rawOffset === null) return

        // 对于非展开模式，semantic offset 等于 raw offset（对于普通文本）
        // 需要转换为 raw offset 来操作 rawText
        const insertOffset = isExpanded ? rawOffset : this.semanticToRawOffset(block, rawOffset)
        if (insertOffset === null) return

        const linkTemplate = '[](url)'
        const newRawText = rawText.slice(0, insertOffset) + linkTemplate + rawText.slice(insertOffset)
        // 光标放在 [] 内
        this.applyRawReconcile(block, newRawText, insertOffset + 1)
      } else {
        // 有选区：用选中文本作为链接文本
        if (!isExpanded) {
          // 非展开模式：先展开
          this.dom.expandBlock(blockId, block)
        }
        const range = getSelectionRawRange(blockEl, selection)
        if (!range) return
        const selectedText = rawText.slice(range.start, range.end)
        const newRawText = rawText.slice(0, range.start) + `[${selectedText}](url)` + rawText.slice(range.end)
        this.applyRawReconcileAndSelect(block, newRawText, range.start + 1, range.start + 1 + selectedText.length)
      }
      return
    }

    // 非链接格式
    if (selection.isCollapsed) {
      // 无选区：插入一对空标记符，光标放中间
      let rawOffset: number | null
      if (isExpanded) {
        rawOffset = computeRawOffset(blockEl, selection.anchorNode, selection.anchorOffset)
      } else {
        const semOffset = computeSemanticOffset(blockEl, selection.anchorNode, selection.anchorOffset, this.doc.prefixOffset(blockId))
        rawOffset = semOffset !== null ? this.semanticToRawOffset(block, semOffset) : null
      }
      if (rawOffset === null) return

      const newRawText = rawText.slice(0, rawOffset) + marker + marker + rawText.slice(rawOffset)
      this.applyRawReconcile(block, newRawText, rawOffset + marker.length)
    } else {
      // 有选区：在选区两端插入/移除标记符
      if (!isExpanded) {
        this.dom.expandBlock(blockId, block)
      }
      const range = getSelectionRawRange(blockEl, selection)
      if (!range) return

      const selectedText = rawText.slice(range.start, range.end)

      // 检测是否已有该标记符（toggle off）
      if (selectedText.startsWith(marker) && selectedText.endsWith(marker) && selectedText.length >= marker.length * 2) {
        // 移除标记符
        const unwrapped = selectedText.slice(marker.length, selectedText.length - marker.length)
        const newRawText = rawText.slice(0, range.start) + unwrapped + rawText.slice(range.end)
        this.applyRawReconcileAndSelect(block, newRawText, range.start, range.start + unwrapped.length)
      } else if (
        range.start >= marker.length &&
        rawText.slice(range.start - marker.length, range.start) === marker &&
        rawText.slice(range.end, range.end + marker.length) === marker
      ) {
        // 标记符在选区外围
        const newRawText = rawText.slice(0, range.start - marker.length) + selectedText + rawText.slice(range.end + marker.length)
        this.applyRawReconcileAndSelect(block, newRawText, range.start - marker.length, range.start - marker.length + selectedText.length)
      } else {
        // 添加标记符
        const newRawText = rawText.slice(0, range.start) + marker + selectedText + marker + rawText.slice(range.end)
        this.applyRawReconcileAndSelect(block, newRawText, range.start + marker.length, range.start + marker.length + selectedText.length)
      }
    }
  }

  /**
   * 将 semantic offset 转换为 raw offset
   */
  private semanticToRawOffset(block: BlockModel, semanticOffset: number): number {
    // semantic offset 在简单情况下就是 raw offset（prefix + char offset，不含标记符）
    // 对于有标记符的 inline，需要重建 raw text 并映射
    const rawText = this.doc.getRawText(block.id)
    const prefixLen = this.doc.prefixOffset(block.id)

    if (semanticOffset <= prefixLen) return semanticOffset

    // 需要遍历 inline model，累加到 semantic offset 对应的 raw position
    const inlines = block.inline ?? []
    let semanticAccum = 0
    let rawAccum = prefixLen

    for (const inline of inlines) {
      if (inline.type === 'text') {
        const hasMarkers = inline.markers && inline.marks !== 0
        if (hasMarkers) {
          rawAccum += inline.markers!.prefix.length
        }

        const textLen = inline.text.length
        const semanticPos = semanticOffset - prefixLen

        if (semanticAccum + textLen >= semanticPos) {
          // 目标在这个 inline 内
          const localOffset = semanticPos - semanticAccum
          return rawAccum + localOffset
        }
        semanticAccum += textLen
        rawAccum += textLen

        if (hasMarkers) {
          rawAccum += inline.markers!.suffix.length
        }
      } else if (inline.type === 'link') {
        // 简化处理：link 内容作为整体
        const linkRaw = `[${this.doc.inlineToRawText(inline.children)}](${inline.href})`
        rawAccum += linkRaw.length
        // link 的 semantic length = children 的文本总长度
        let linkSemanticLen = 0
        for (const child of inline.children) {
          if (child.type === 'text') linkSemanticLen += child.text.length
        }
        semanticAccum += linkSemanticLen
      }
    }

    // Fallback：直接返回（可能超出范围）
    return Math.min(rawAccum, rawText.length)
  }

  /**
   * 处理 Tab / Shift+Tab 缩进操作
   * - 在列表项上：增加/减少 2 个空格的缩进
   * - 在代码块内：插入/移除 2 个空格
   * - 其他类型：插入/移除 2 个空格缩进
   */
  private handleIndent(selection: SelectionSnapshot | null, direction: 'indent' | 'outdent') {
    if (!selection || !selection.anchorNode) return

    const blockId = getIdFromBlock(selection.anchorNode)
    const block = this.doc.getBlock(blockId)
    const blockEl = this.dom.getNodeById(blockId)
    if (!block || !blockEl) return

    const rawText = this.doc.getRawText(blockId)
    const isExpanded = this.dom.getExpandedBlockId() === blockId

    // 代码块内：在光标位置插入/删除 2 个空格
    if (block.type === 'code-block') {
      if (!isExpanded) return
      const rawOffset = computeRawOffset(blockEl, selection.anchorNode, selection.anchorOffset)
      if (rawOffset === null) return

      if (direction === 'indent') {
        const newRawText = rawText.slice(0, rawOffset) + '    ' + rawText.slice(rawOffset)
        this.applyRawReconcile(block, newRawText, rawOffset + 4)
      } else {
        // 找当前行行首，删除最多 4 个空格
        const lineStart = rawText.lastIndexOf('\n', rawOffset - 1) + 1
        let spacesToRemove = 0
        for (let i = lineStart; i < lineStart + 4 && i < rawText.length; i++) {
          if (rawText[i] === ' ') spacesToRemove++
          else break
        }
        if (spacesToRemove > 0) {
          const newRawText = rawText.slice(0, lineStart) + rawText.slice(lineStart + spacesToRemove)
          const newOffset = Math.max(lineStart, rawOffset - spacesToRemove)
          this.applyRawReconcile(block, newRawText, newOffset)
        }
      }
      return
    }

    // 列表项、段落等：修改行首缩进
    const nesting = block.nesting ?? 0

    if (direction === 'indent') {
      // 增加 4 个空格缩进
      const newRawText = '    ' + rawText

      // 计算光标的新位置
      let cursorRawOffset: number
      if (isExpanded) {
        const rawOffset = computeRawOffset(blockEl, selection.anchorNode, selection.anchorOffset)
        cursorRawOffset = (rawOffset ?? 0) + 4
      } else {
        cursorRawOffset = this.doc.prefixOffset(blockId) + 4
      }

      this.applyRawReconcile(block, newRawText, cursorRawOffset)
    } else {
      // 减少缩进：移除行首最多 4 个空格
      if (nesting <= 0) return

      const spacesToRemove = Math.min(4, nesting)
      const newRawText = rawText.slice(spacesToRemove)

      let cursorRawOffset: number
      if (isExpanded) {
        const rawOffset = computeRawOffset(blockEl, selection.anchorNode, selection.anchorOffset)
        cursorRawOffset = Math.max(0, (rawOffset ?? 0) - spacesToRemove)
      } else {
        cursorRawOffset = Math.max(0, this.doc.prefixOffset(blockId) - spacesToRemove)
      }

      this.applyRawReconcile(block, newRawText, cursorRawOffset)
    }
  }

  /**
   * 处理图片拖拽上传
   * 将拖拽的图片文件转换为 base64 data URL，插入 Markdown 图片语法
   */
  private handleImageDrop(selection: SelectionSnapshot | null, files: FileList) {
    // 筛选图片文件
    const imageFiles: File[] = []
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file.type.startsWith('image/')) {
        imageFiles.push(file)
      }
    }
    if (imageFiles.length === 0) return

    // 逐个读取图片文件并插入
    const promises = imageFiles.map(file => {
      return new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const alt = file.name
          resolve(`![${alt}](${dataUrl})`)
        }
        reader.onerror = () => resolve('')
        reader.readAsDataURL(file)
      })
    })

    Promise.all(promises).then(markdownImages => {
      const validImages = markdownImages.filter(s => s.length > 0)
      if (validImages.length === 0) return

      // 获取当前光标位置
      const currentSelection = this.controller['captureSelection']?.() ?? selection
      if (!currentSelection || !currentSelection.anchorNode) return

      const blockId = getIdFromBlock(currentSelection.anchorNode)
      const block = this.doc.getBlock(blockId)
      const blockEl = this.dom.getNodeById(blockId)
      if (!block || !blockEl) return

      const isExpanded = this.dom.getExpandedBlockId() === blockId
      const rawText = this.doc.getRawText(blockId)

      // 计算插入位置
      let rawOffset: number | null
      if (isExpanded) {
        rawOffset = computeRawOffset(blockEl, currentSelection.anchorNode!, currentSelection.anchorOffset)
      } else {
        rawOffset = rawText.length // 非展开模式，插入到行尾
      }
      if (rawOffset === null) rawOffset = rawText.length

      // 如果是空行，直接替换；否则在光标位置插入
      const insertText = validImages.join('\n')
      if (rawText.trim() === '') {
        // 空行：直接用图片语法替换
        this.applyRawReconcile(block, insertText, insertText.length)
      } else {
        // 非空行：在光标位置插入（如果多张图片需要换行处理）
        if (validImages.length === 1) {
          const newRawText = rawText.slice(0, rawOffset) + insertText + rawText.slice(rawOffset)
          this.applyRawReconcile(block, newRawText, rawOffset + insertText.length)
        } else {
          // 多张图片：在当前行后依次创建新行
          const lines = [rawText.slice(0, rawOffset) + validImages[0] + rawText.slice(rawOffset)]
          for (let i = 1; i < validImages.length; i++) {
            lines.push(validImages[i])
          }
          // 使用类似多行粘贴的方式处理
          this.handlePasteMultiLine(block, blockEl, currentSelection, lines, isExpanded)
        }
      }

      this.notifyContentChange()
    })
  }

  /**
   * 处理链接 hover——显示编辑弹窗
   * 鼠标悬停在链接上时弹出一个浮层，可编辑 URL 和文本
   */
  private handleLinkHover(
    linkInfo: { href: string; text: string; blockId: string; rect: { left: number; top: number; bottom: number; right: number } },
    linkElement: HTMLAnchorElement | null
  ) {
    // 如果已存在弹窗，不重复创建
    const existingPopup = this.view.container.querySelector('.md-link-popup')
    if (existingPopup) return

    const { href, text, blockId, rect } = linkInfo
    const containerRect = this.view.container.getBoundingClientRect()

    // 创建弹窗容器
    const popup = document.createElement('div')
    popup.className = 'md-link-popup'
    popup.style.cssText = `
      position: absolute;
      left: ${rect.left - containerRect.left}px;
      top: ${rect.bottom - containerRect.top + 4}px;
      z-index: 1000;
      background: #fff;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      padding: 12px;
      min-width: 300px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `

    // URL 显示行
    const urlRow = document.createElement('div')
    urlRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;'
    const urlIcon = document.createElement('span')
    urlIcon.textContent = '🔗'
    urlIcon.style.cssText = 'flex-shrink: 0; font-size: 14px;'
    urlRow.appendChild(urlIcon)
    const urlInput = document.createElement('input')
    urlInput.type = 'text'
    urlInput.value = href
    urlInput.placeholder = '链接地址'
    urlInput.style.cssText = 'flex: 1; border: 1px solid #e0e0e0; border-radius: 4px; padding: 4px 8px; font-size: 13px; outline: none; font-family: "Maple Mono", Consolas, monospace; color: #267AE9;'
    urlRow.appendChild(urlInput)
    popup.appendChild(urlRow)

    // 文本显示行
    const textRow = document.createElement('div')
    textRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;'
    const textIcon = document.createElement('span')
    textIcon.textContent = '📝'
    textIcon.style.cssText = 'flex-shrink: 0; font-size: 14px;'
    textRow.appendChild(textIcon)
    const textInput = document.createElement('input')
    textInput.type = 'text'
    textInput.value = text
    textInput.placeholder = '链接文本'
    textInput.style.cssText = 'flex: 1; border: 1px solid #e0e0e0; border-radius: 4px; padding: 4px 8px; font-size: 13px; outline: none;'
    textRow.appendChild(textInput)
    popup.appendChild(textRow)

    // 按钮行
    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px;'

    const openBtn = document.createElement('button')
    openBtn.textContent = '打开链接'
    openBtn.style.cssText = 'padding: 4px 12px; border: 1px solid #d0d0d0; border-radius: 4px; background: #f8f8f8; cursor: pointer; font-size: 12px;'
    openBtn.addEventListener('click', () => {
      const url = urlInput.value.trim()
      if (url) window.open(url, '_blank')
    })
    btnRow.appendChild(openBtn)

    const saveBtn = document.createElement('button')
    saveBtn.textContent = '保存修改'
    saveBtn.style.cssText = 'padding: 4px 12px; border: none; border-radius: 4px; background: #267AE9; color: #fff; cursor: pointer; font-size: 12px;'
    saveBtn.addEventListener('click', () => {
      const newHref = urlInput.value.trim()
      const newText = textInput.value.trim()
      if (newHref && newText) {
        this.updateLinkByInfo(blockId, text, href, newText, newHref)
      }
      popup.remove()
    })
    btnRow.appendChild(saveBtn)
    popup.appendChild(btnRow)

    // 关闭逻辑：鼠标离开弹窗 + 链接元素区域时关闭
    let closeTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleClose = () => {
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = setTimeout(() => {
        popup.remove()
        cleanup()
      }, 300) // 300ms 延迟，给用户从链接移到弹窗的缓冲时间
    }

    const cancelClose = () => {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
    }

    // 弹窗的鼠标事件
    popup.addEventListener('mouseenter', cancelClose)
    popup.addEventListener('mouseleave', scheduleClose)

    // 链接元素的鼠标事件（如果元素仍在 DOM 中）
    if (linkElement && this.view.container.contains(linkElement)) {
      linkElement.addEventListener('mouseleave', scheduleClose)
      linkElement.addEventListener('mouseenter', cancelClose)
    } else {
      // 链接元素不在了（可能已展开），启动关闭定时器
      scheduleClose()
    }

    // 点击弹窗内输入框时，阻止冒泡以防止编辑器展开/收起
    popup.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      cancelClose() // 正在交互，不要关闭
    })

    const cleanup = () => {
      if (linkElement) {
        linkElement.removeEventListener('mouseleave', scheduleClose)
        linkElement.removeEventListener('mouseenter', cancelClose)
      }
    }

    // 添加到容器
    this.view.container.style.position = 'relative'
    this.view.container.appendChild(popup)
  }

  /**
   * 通过 blockId 和旧文本/URL 更新链接
   */
  private updateLinkByInfo(blockId: string, oldText: string, oldHref: string, newText: string, newHref: string) {
    const block = this.doc.getBlock(blockId)
    if (!block) return

    const rawText = this.doc.getRawText(blockId)

    const oldLink = `[${oldText}](${oldHref})`
    const newLink = `[${newText}](${newHref})`

    const idx = rawText.indexOf(oldLink)
    if (idx === -1) return

    const newRawText = rawText.slice(0, idx) + newLink + rawText.slice(idx + oldLink.length)

    // 保存快照用于 undo
    const cursorInfo = this.getCurrentCursorInfo(
      this.controller['captureSelection']?.() ?? null
    )
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    // 应用更改
    const effect = this.doc.reconcileFromRawText(blockId, newRawText)
    if (!effect) return
    if (effect.kind === 'code-block-degrade') return
    const targetBlock = effect.kind === 'block-transform' ? effect.to : effect.block
    if (effect.kind === 'block-transform') {
      this.dom.replaceBlock(effect.from, effect.to)
    } else {
      this.dom.replaceBlock(targetBlock, targetBlock)
    }

    this.notifyContentChange()
  }

  /**
   * 处理脚注跳转——Cmd+Click 脚注引用时滚动到对应的脚注定义块并展开
   */
  private handleFootnoteJump(footnoteId: string) {
    // 1. 在所有 blocks 中查找对应的脚注定义块
    let targetBlockId: string | null = null
    for (const [id, block] of this.doc.getBlocks()) {
      if ('footnoteId' in block && (block as any).footnoteId === footnoteId) {
        targetBlockId = id
        break
      }
    }
    if (!targetBlockId) return

    const targetBlock = this.doc.getBlock(targetBlockId)
    if (!targetBlock) return

    // 2. 收起当前展开的 block
    const expandedBlockId = this.dom.getExpandedBlockId()
    if (expandedBlockId) {
      const oldBlock = this.doc.getBlock(expandedBlockId)
      if (oldBlock) {
        this.dom.collapseBlock(oldBlock)
      }
    }

    // 3. 展开目标脚注定义块
    this.dom.expandBlock(targetBlockId, targetBlock)

    // 4. 滚动到目标块（平滑滚动）
    const targetEl = this.dom.getNodeById(targetBlockId)
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }

    // 5. 高亮目标块
    this.dom.clearHighlight()
    this.scheduler.highlightBlock(targetBlockId, BlockVisualState.active)
    this.skipNextSelectionAction = true
  }

  /**
   * 处理图片 hover——显示编辑弹窗
   * 鼠标悬停在图片上时弹出浮层，可编辑 src 和 alt
   */
  private handleImageHover(
    imageInfo: { src: string; alt: string; blockId: string; rect: { left: number; top: number; bottom: number; right: number } }
  ) {
    // 如果已存在弹窗，不重复创建
    const existingPopup = this.view.container.querySelector('.md-image-popup')
    if (existingPopup) return

    const { src, alt, blockId, rect } = imageInfo
    const containerRect = this.view.container.getBoundingClientRect()

    const popup = document.createElement('div')
    popup.className = 'md-image-popup'
    popup.style.cssText = `
      position: absolute;
      left: ${rect.left - containerRect.left}px;
      top: ${rect.bottom - containerRect.top + 4}px;
      z-index: 1000;
      background: #fff;
      border: 1px solid #d0d0d0;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      padding: 12px;
      min-width: 300px;
      font-size: 13px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `

    // 图片地址行
    const srcRow = document.createElement('div')
    srcRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 8px;'
    const srcIcon = document.createElement('span')
    srcIcon.textContent = '🖼️'
    srcIcon.style.cssText = 'flex-shrink: 0; font-size: 14px;'
    srcRow.appendChild(srcIcon)
    const srcInput = document.createElement('input')
    srcInput.type = 'text'
    srcInput.value = src
    srcInput.placeholder = '图片地址'
    srcInput.style.cssText = 'flex: 1; border: 1px solid #e0e0e0; border-radius: 4px; padding: 4px 8px; font-size: 13px; outline: none; font-family: "Maple Mono", Consolas, monospace; color: #267AE9;'
    srcRow.appendChild(srcInput)
    popup.appendChild(srcRow)

    // Alt 文本行
    const altRow = document.createElement('div')
    altRow.style.cssText = 'display: flex; align-items: center; gap: 8px; margin-bottom: 10px;'
    const altIcon = document.createElement('span')
    altIcon.textContent = '📝'
    altIcon.style.cssText = 'flex-shrink: 0; font-size: 14px;'
    altRow.appendChild(altIcon)
    const altInput = document.createElement('input')
    altInput.type = 'text'
    altInput.value = alt
    altInput.placeholder = '替代文本'
    altInput.style.cssText = 'flex: 1; border: 1px solid #e0e0e0; border-radius: 4px; padding: 4px 8px; font-size: 13px; outline: none;'
    altRow.appendChild(altInput)
    popup.appendChild(altRow)

    // 按钮行
    const btnRow = document.createElement('div')
    btnRow.style.cssText = 'display: flex; justify-content: flex-end; gap: 8px;'

    const openBtn = document.createElement('button')
    openBtn.textContent = '查看原图'
    openBtn.style.cssText = 'padding: 4px 12px; border: 1px solid #d0d0d0; border-radius: 4px; background: #f8f8f8; cursor: pointer; font-size: 12px;'
    openBtn.addEventListener('click', () => {
      const url = srcInput.value.trim()
      if (url) window.open(url, '_blank')
    })
    btnRow.appendChild(openBtn)

    const saveBtn = document.createElement('button')
    saveBtn.textContent = '保存修改'
    saveBtn.style.cssText = 'padding: 4px 12px; border: none; border-radius: 4px; background: #267AE9; color: #fff; cursor: pointer; font-size: 12px;'
    saveBtn.addEventListener('click', () => {
      const newSrc = srcInput.value.trim()
      const newAlt = altInput.value
      if (newSrc) {
        this.updateImageByInfo(blockId, alt, src, newAlt, newSrc)
      }
      popup.remove()
    })
    btnRow.appendChild(saveBtn)
    popup.appendChild(btnRow)

    // 关闭逻辑
    let closeTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleClose = () => {
      if (closeTimer) clearTimeout(closeTimer)
      closeTimer = setTimeout(() => {
        popup.remove()
      }, 300)
    }

    const cancelClose = () => {
      if (closeTimer) {
        clearTimeout(closeTimer)
        closeTimer = null
      }
    }

    popup.addEventListener('mouseenter', cancelClose)
    popup.addEventListener('mouseleave', scheduleClose)

    // 找到对应的 img 元素绑定 mouseleave
    const imgEl = this.view.container.querySelector(`.md-line-block[data-block-id="${blockId}"] img.md-image`) as HTMLElement | null
    if (imgEl) {
      imgEl.addEventListener('mouseleave', scheduleClose)
      imgEl.addEventListener('mouseenter', cancelClose)
    }

    popup.addEventListener('mousedown', (e) => {
      e.stopPropagation()
      cancelClose()
    })

    this.view.container.style.position = 'relative'
    this.view.container.appendChild(popup)
  }

  /**
   * 通过 blockId 和旧 alt/src 更新图片
   */
  private updateImageByInfo(blockId: string, oldAlt: string, oldSrc: string, newAlt: string, newSrc: string) {
    const block = this.doc.getBlock(blockId)
    if (!block) return

    const rawText = this.doc.getRawText(blockId)

    const oldImage = `![${oldAlt}](${oldSrc})`
    const newImage = `![${newAlt}](${newSrc})`

    const idx = rawText.indexOf(oldImage)
    if (idx === -1) return

    const newRawText = rawText.slice(0, idx) + newImage + rawText.slice(idx + oldImage.length)

    const cursorInfo = this.getCurrentCursorInfo(
      this.controller['captureSelection']?.() ?? null
    )
    this.history.beginTransaction(this.doc.getHistoryState(), cursorInfo)

    const effect = this.doc.reconcileFromRawText(blockId, newRawText)
    if (!effect) return
    if (effect.kind === 'code-block-degrade') return
    const targetBlock = effect.kind === 'block-transform' ? effect.to : effect.block
    if (effect.kind === 'block-transform') {
      this.dom.replaceBlock(effect.from, effect.to)
    } else {
      this.dom.replaceBlock(targetBlock, targetBlock)
    }

    this.notifyContentChange()
  }
}

const getBlockAnchor = (node: Node): HTMLDivElement | null => {
  const element =
    node instanceof Element
      ? node
      : node?.parentElement
  return element?.closest('.md-line-block') as HTMLDivElement
} 

const getIdFromBlock = (node: Node): string => {
  return getBlockAnchor(node)?.dataset.blockId ?? ''
}

/**
 * 计算光标在 block 中的语义偏移量
 * 语义偏移 = prefixOffset + 光标在 md-inline-content 中的字符偏移（排除标记符文本）
 * 
 * 这个偏移量与 DocumentController.recoveryOffset 期望的 offset 一致
 */
function computeSemanticOffset(
  blockEl: HTMLElement,
  anchorNode: Node,
  anchorOffset: number,
  prefixOffset: number
): number | null {
  // 检查光标是否在结构性标记符内（indent、list marker、heading marker）
  if (isInStructMarkerSpan(anchorNode)) {
    // 光标在结构性标记符内，返回 prefixOffset（即文本开头）
    return prefixOffset
  }

  // 找到 md-inline-content 元素
  const inlineContent = blockEl.querySelector('.md-inline-content')
  if (!inlineContent) return null

  // 确认光标确实在 inline-content 内部
  if (!inlineContent.contains(anchorNode)) {
    // 光标可能在 marker 或 indent 上，返回 prefixOffset（即文本开头）
    return prefixOffset
  }

  // 遍历 inline-content 中的所有文本节点，计算光标的字符偏移
  // 跳过 .md-marker 中的文本节点
  const walker = document.createTreeWalker(
    inlineContent,
    NodeFilter.SHOW_TEXT,
    null
  )

  let charOffset = 0
  let textNode: Text | null
  while ((textNode = walker.nextNode() as Text)) {
    const inMarker = isInMarkerSpan(textNode)
    const inStructMarker = isInStructuralMarkerSpan(textNode)
    
    if (textNode === anchorNode) {
      if (inMarker) {
        // 光标在标记符文本中，映射到最近的语义位置
        // 判断是前缀还是后缀标记符
        const markerEl = textNode.parentElement!
        const expandedSpan = markerEl.parentElement!
        const markers = expandedSpan.querySelectorAll('.md-marker')
        if (markers[0] === markerEl) {
          // 前缀标记符 → 语义偏移为当前累积值（文本开头）
          return prefixOffset + charOffset
        } else {
          // 后缀标记符 → 语义偏移为当前累积值（文本末尾）
          return prefixOffset + charOffset
        }
      }
      if (inStructMarker) {
        // 光标在结构性标记符（如 •、1.）内，映射到 prefixOffset
        return prefixOffset
      }
      // 找到了光标所在的文本节点
      return prefixOffset + charOffset + anchorOffset
    }
    
    if (!inMarker && !inStructMarker) {
      charOffset += textNode.textContent?.length ?? 0
    }
  }

  // 没找到，返回 null
  return null
}

/**
 * 判断一个文本节点是否在 .md-marker span 内部（inline 标记符如 **、~~）
 */
function isInMarkerSpan(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    if (el.classList.contains('md-marker')) return true
    if (el.classList.contains('md-inline-content')) return false
    el = el.parentElement
  }
  return false
}

/**
 * 判断一个文本节点是否在结构性 marker 元素内部
 * 包括：.md-list-marker、.md-list-number（非展开模式的列表标记如 • 或 1.）
 * 这些文本已经被 prefixOffset 计入，不应再参与 charOffset 计算
 */
function isInStructuralMarkerSpan(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    if (el.classList.contains('md-list-marker') || el.classList.contains('md-list-number')) return true
    if (el.classList.contains('md-inline-content')) return false
    el = el.parentElement
  }
  return false
}

/**
 * 判断一个文本节点是否在 .md-struct-marker span 内部（结构性标记符如 indent、list marker、heading marker）
 */
function isInStructMarkerSpan(node: Node): boolean {
  let el = node instanceof Element ? node : node.parentElement
  while (el) {
    if (el.classList.contains('md-struct-marker')) return true
    if (el.classList.contains('md-line-block')) return false
    el = el.parentElement
  }
  return false
}


function computeRawOffset(blockEl: HTMLElement, anchorNode: Node, anchorOffset: number): number | null {
  if (!blockEl.contains(anchorNode)) return null
  const range = document.createRange()
  range.setStart(blockEl, 0)
  range.setEnd(anchorNode, anchorOffset)
  const fragment = range.cloneContents()
  fragment.querySelectorAll('[data-raw-placeholder], [data-empty-caret]').forEach(node => node.remove())
  return fragment.textContent?.length ?? 0
}

/**
 * 计算非空选区在 block raw text 中的起止偏移量
 * 返回 { start, end } 其中 start < end（无论选区方向）
 */
function getSelectionRawRange(
  blockEl: HTMLElement,
  selection: SelectionSnapshot
): { start: number; end: number } | null {
  if (!selection.anchorNode || !selection.focusNode) return null

  const anchorOffset = computeRawOffset(blockEl, selection.anchorNode, selection.anchorOffset)
  const focusOffset = computeRawOffset(blockEl, selection.focusNode, selection.focusOffset)

  if (anchorOffset === null || focusOffset === null) return null

  return {
    start: Math.min(anchorOffset, focusOffset),
    end: Math.max(anchorOffset, focusOffset)
  }
}

function createInactiveInlineFormatState(): InlineFormatState {
  return {
    bold: 'inactive',
    italic: 'inactive',
    strikethrough: 'inactive',
    highlight: 'inactive',
    code: 'inactive',
    link: 'inactive'
  }
}

function createMixedInlineFormatState(): InlineFormatState {
  return {
    bold: 'mixed',
    italic: 'mixed',
    strikethrough: 'mixed',
    highlight: 'mixed',
    code: 'mixed',
    link: 'mixed'
  }
}

function getInlineFormatStateForRange(
  inlines: InlineModel[],
  start: number,
  end: number
): InlineFormatState {
  const segments = collectInlineCoverageSegments(inlines)
    .filter(segment => segment.end > start && segment.start < end)

  if (segments.length === 0) return createInactiveInlineFormatState()

  return getInlineFormatStateFromSegments(segments)
}

function getInlineFormatStateForRawRange(
  inlines: InlineModel[],
  start: number,
  end: number
): InlineFormatState {
  const segments = collectRawInlineCoverageSegments(inlines).segments
    .filter(segment => segment.end > start && segment.start < end)

  if (segments.length === 0) return createInactiveInlineFormatState()

  return getInlineFormatStateFromSegments(segments)
}

function getInlineFormatStateFromSegments(segments: InlineCoverageSegment[]): InlineFormatState {
  const state: InlineFormatState = {
    bold: getSegmentStatus(segments, INLINE_FLAG.BOLD),
    italic: getSegmentStatus(segments, INLINE_FLAG.ITALIC),
    strikethrough: getSegmentStatus(segments, INLINE_FLAG.STRIKE),
    highlight: getSegmentStatus(segments, INLINE_FLAG.HIGHLIGHT),
    code: getSegmentStatus(segments, INLINE_FLAG.CODE),
    link: getLinkSegmentStatus(segments)
  }
  const signatures = new Set(segments.map(segment => `${segment.marks}:${segment.link}`))
  if (signatures.size <= 1) return state

  return {
    bold: state.bold === 'inactive' ? 'inactive' : 'mixed',
    italic: state.italic === 'inactive' ? 'inactive' : 'mixed',
    strikethrough: state.strikethrough === 'inactive' ? 'inactive' : 'mixed',
    highlight: state.highlight === 'inactive' ? 'inactive' : 'mixed',
    code: state.code === 'inactive' ? 'inactive' : 'mixed',
    link: state.link === 'inactive' ? 'inactive' : 'mixed'
  }
}

function getSegmentStatus(
  segments: InlineCoverageSegment[],
  flag: INLINE_FLAG
): InlineFormatStatus {
  const hasActive = segments.some(segment => Boolean(segment.marks & flag))
  const hasInactive = segments.some(segment => !Boolean(segment.marks & flag))
  if (hasActive && hasInactive) return 'mixed'
  return hasActive ? 'active' : 'inactive'
}

function getLinkSegmentStatus(segments: InlineCoverageSegment[]): InlineFormatStatus {
  const hasActive = segments.some(segment => segment.link)
  const hasInactive = segments.some(segment => !segment.link)
  if (hasActive && hasInactive) return 'mixed'
  return hasActive ? 'active' : 'inactive'
}

function collectInlineCoverageSegments(
  inlines: InlineModel[],
  inheritedMarks = 0,
  baseOffset = 0,
  inLink = false
): InlineCoverageSegment[] {
  const segments: InlineCoverageSegment[] = []

  for (const inline of inlines) {
    const marks = inheritedMarks | inline.marks
    const start = baseOffset + inline.offset

    if (inline.type === 'text') {
      segments.push({
        start,
        end: start + inline.text.length,
        marks,
        link: inLink
      })
      continue
    }

    if (inline.type === 'link') {
      segments.push(...collectInlineCoverageSegments(inline.children, marks, start, true))
      continue
    }

    if (inline.type === 'image') {
      segments.push({
        start,
        end: start + inline.alt.length,
        marks,
        link: inLink
      })
      continue
    }

    if (inline.type === 'math') {
      segments.push({
        start,
        end: start + inline.tex.length,
        marks,
        link: inLink
      })
      continue
    }

    if (inline.type === 'footnote-ref') {
      segments.push({
        start,
        end: start + inline.id.length,
        marks,
        link: inLink
      })
    }
  }

  return segments.filter(segment => segment.end > segment.start)
}

function collectRawInlineCoverageSegments(
  inlines: InlineModel[],
  inheritedMarks = 0,
  baseOffset = 0,
  inLink = false
): RawInlineCoverage {
  const segments: InlineCoverageSegment[] = []
  let rawOffset = 0

  for (const inline of inlines) {
    const marks = inheritedMarks | inline.marks
    const inlineStart = baseOffset + rawOffset

    if (inline.type === 'text') {
      if (inline.rawStart !== undefined && inline.rawEnd !== undefined) {
        segments.push({
          start: baseOffset + inline.rawStart,
          end: baseOffset + inline.rawEnd,
          marks,
          link: inLink
        })
        rawOffset = Math.max(rawOffset, inline.rawEnd)
        continue
      }

      const prefixLength = inline.markers && inline.marks !== 0 ? inline.markers.prefix.length : 0
      const suffixLength = inline.markers && inline.marks !== 0 ? inline.markers.suffix.length : 0
      const contentStart = inlineStart + prefixLength
      const contentEnd = contentStart + inline.text.length
      segments.push({
        start: contentStart,
        end: contentEnd,
        marks,
        link: inLink
      })
      rawOffset += prefixLength + inline.text.length + suffixLength
      continue
    }

    if (inline.type === 'link') {
      const linkStart = inline.rawStart !== undefined ? baseOffset + inline.rawStart : inlineStart
      const linkTextCoverage = collectRawInlineCoverageSegments(inline.children, marks, linkStart + 1, true)
      segments.push(...linkTextCoverage.segments)
      rawOffset = inline.rawEnd !== undefined
        ? Math.max(rawOffset, inline.rawEnd)
        : rawOffset + 1 + linkTextCoverage.rawLength + 2 + inline.href.length + 1
      continue
    }

    if (inline.type === 'image') {
      const contentStart = inline.rawStart !== undefined ? baseOffset + inline.rawStart : inlineStart + 2
      const contentEnd = inline.rawEnd !== undefined ? baseOffset + inline.rawEnd : contentStart + inline.alt.length
      segments.push({
        start: contentStart,
        end: contentEnd,
        marks,
        link: inLink
      })
      rawOffset = inline.rawEnd !== undefined
        ? Math.max(rawOffset, inline.rawEnd)
        : rawOffset + 2 + inline.alt.length + 2 + inline.src.length + 1
      continue
    }

    if (inline.type === 'math') {
      const contentStart = inline.rawStart !== undefined ? baseOffset + inline.rawStart : inlineStart + 1
      const contentEnd = inline.rawEnd !== undefined ? baseOffset + inline.rawEnd : contentStart + inline.tex.length
      segments.push({
        start: contentStart,
        end: contentEnd,
        marks,
        link: inLink
      })
      rawOffset = inline.rawEnd !== undefined
        ? Math.max(rawOffset, inline.rawEnd)
        : rawOffset + inline.tex.length + 2
      continue
    }

    if (inline.type === 'footnote-ref') {
      const contentStart = inline.rawStart !== undefined ? baseOffset + inline.rawStart : inlineStart + 2
      const contentEnd = inline.rawEnd !== undefined ? baseOffset + inline.rawEnd : contentStart + inline.id.length
      segments.push({
        start: contentStart,
        end: contentEnd,
        marks,
        link: inLink
      })
      rawOffset = inline.rawEnd !== undefined
        ? Math.max(rawOffset, inline.rawEnd)
        : rawOffset + inline.id.length + 3
    }
  }

  return {
    segments: segments.filter(segment => segment.end > segment.start),
    rawLength: rawOffset
  }
}

function isAutoPairCharacter(char: string): boolean {
  return char === '*' || char === '_' || char === '`'
}

function isEscaped(text: string, offset: number): boolean {
  let slashCount = 0
  for (let i = offset - 1; i >= 0 && text[i] === '\\'; i--) {
    slashCount++
  }
  return slashCount % 2 === 1
}

function isInRawPlaceholderSpan(node: Node): boolean {
  let el = node instanceof Element ? node : node.parentElement
  while (el) {
    if (el instanceof HTMLElement && el.dataset.rawPlaceholder) return true
    if (el.classList.contains('md-line-block')) return false
    el = el.parentElement
  }
  return false
}

function parseOpeningCodeFence(rawText: string): { marker: string } | null {
  const match = rawText.match(/^(`{3,}|~{3,})[ \t]*(.*)$/)
  if (!match) return null
  return { marker: match[1] }
}

function parseClosingCodeFence(rawText: string): string | null {
  const match = rawText.match(/^(`{3,}|~{3,})[ \t]*$/)
  return match ? match[1] : null
}
