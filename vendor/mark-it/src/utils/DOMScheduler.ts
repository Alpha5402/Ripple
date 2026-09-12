import { DOMController } from './DOMController'
import { DocumentController } from './DocumentController'

export class DOMScheduler {
  private activeBlocks: Set<HTMLElement> = new Set()
  private dirtyBlocks: Set<HTMLElement> = new Set()
  private dom: DOMController
  private doc: DocumentController

  constructor(dom: DOMController, doc: DocumentController) {
    this.dom = dom
    this.doc = doc
  }

  highlightBlock(BlockId: string, type: number) {
    this.dom.clearHighlight()
    this.dom.highlightBlock(
      BlockId, type 
    )
  }

  markDirty(BlockId: string) {
    const node = this.dom.getNodeById(BlockId)
    if (node) {
      if (node.classList.contains('md-block-active')) {
        node.classList.remove('md-block-active')
      }
      node.classList.add('md-block-dirty')
      this.dirtyBlocks.add(node)
    }
  }

  insertText(BlockId: string, offset: number, text: string, nextCursorOffset: number = 0) {
    new Promise(resolve => {
      this.doc.insertText(BlockId, offset, text)
      resolve(true)
    }).then(() => {
      const block = this.doc.getBlock(BlockId)
      if (!block) return
      const prefixOffset = this.doc.prefixOffset(BlockId)
      this.dom.updateDOM(block, prefixOffset, nextCursorOffset)
    })
  }

  handleDeleteBackward(blockId: string, offset: number) {
    const result = this.doc.deleteText(blockId, offset)
    if (!result) {
      // 需要跨 block 合并
      this.handleMergeWithPreviousBlock(blockId)
      return
    }

    const block = this.doc.getBlock(blockId)
    if (!block) return
    const prefixOffset = this.doc.prefixOffset(blockId)
    this.dom.updateDOM(block, prefixOffset, result.newOffset)
  }

  /**
   * 跨 Block 合并：将当前 block 的内容合并到前一个 block 末尾，然后删除当前 block
   * 合并后展开前一个 block 并定位光标到合并点
   */
  private handleMergeWithPreviousBlock(blockId: string) {
    const mergeResult = this.doc.mergeBlockWithPrevious(blockId)
    if (!mergeResult) return

    const { mergedBlock, cursorRawOffset, removedBlockId } = mergeResult

    // 1. 从 DOM 移除被删除的 block 节点
    this.dom.removeBlockNode(removedBlockId)

    // 2. 重新渲染合并后的 block（先收起再渲染）
    this.dom.replaceBlock(mergedBlock, mergedBlock)

    // 3. 展开合并后的 block 并定位光标到合并点
    this.dom.forceResetExpanded()
    this.dom.renderBlockExpanded(mergedBlock)
    this.dom.setCursorByRawOffset(mergedBlock.id, cursorRawOffset)
  }

  handleInsertLineBreak(blockId: string, offset: number) {
    const result = this.doc.splitBlock(blockId, offset)
    const origin = this.doc.getBlock(blockId)

    this.markDirty(blockId)

    if (!result || !origin) return

    queueMicrotask(() => {
      const prefixOffset = this.doc.prefixOffset(blockId)
      this.dom.updateDOM(origin, prefixOffset)
      this.dom.purify()
      this.dom.insertBlock(origin, result)

      const newPrefixOffset = this.doc.prefixOffset(result.id)
      this.dom.setCursor(result.id, newPrefixOffset, newPrefixOffset, 'current')
    })
  }

  /**
   * 销毁 DOMScheduler，清空内部状态
   */
  destroy() {
    this.activeBlocks.clear()
    this.dirtyBlocks.clear()
  }
}