import { BlockModel, InlineModel, TextInline, LinkInline, BlockVisualState, DivideUnit, TableBlock, CodeBlock, HTMLPolicy } from "../types"
import { renderBlock, renderInlineBlock } from "./render"

/**
 * 判断一个文本节点是否在 .md-marker 元素内部（inline 标记符如 **、~~）
 */
function isInsideMarker(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    if (el.classList.contains('md-marker')) return true
    if (el.classList.contains('md-inline-content')) return false
    el = el.parentElement
  }
  return false
}

/**
 * 判断一个文本节点是否在 .md-struct-marker 元素内部（结构性标记符如 indent、list marker、heading marker）
 */
function isInsideStructMarker(node: Node): boolean {
  let el = node.parentElement
  while (el) {
    if (el.classList.contains('md-struct-marker')) return true
    if (el.classList.contains('md-line-block')) return false
    el = el.parentElement
  }
  return false
}

function isInsideRawPlaceholder(node: Node): boolean {
  let el = node instanceof Element ? node : node.parentElement
  while (el) {
    if (el instanceof HTMLElement && el.dataset.rawPlaceholder) return true
    if (el.classList.contains('md-line-block')) return false
    el = el.parentElement
  }
  return false
}

export class DOMController {
  private nodes = new Map<string, HTMLDivElement>()
  private highLightedBlocks = new Set<HTMLElement>()
  private container: HTMLDivElement
  constructor(
    container: HTMLDivElement, 
    models: BlockModel[],
    private readonly getRawText?: (blockId: string) => string,
    private readonly htmlPolicy: HTMLPolicy = 'sanitize'
  ) {
    this.container = container
    models.forEach(model => {
      const rendered = renderBlock(model, false, this.getRawText?.(model.id), this.htmlPolicy)
      const wrapper = this.fragmentToElement(rendered)
      wrapper.dataset.blockId = model.id
      this.nodes.set(model.id, wrapper)
      container.appendChild(wrapper)
    })
  }

  /**
   * 从新的 block 列表完全重建 DOM（用于 Undo/Redo）
   * 清空现有节点，重新渲染所有 blocks
   */
  fullRebuild(models: BlockModel[]): void {
    // 清空现有 DOM 和映射
    this.container.innerHTML = ''
    this.nodes.clear()
    this.highLightedBlocks.clear()
    this.expandedBlockId = null
    this.multiExpandedBlockIds.clear()

    // 重新渲染所有 blocks
    models.forEach(model => {
      const rendered = renderBlock(model, false, this.getRawText?.(model.id), this.htmlPolicy)
      const wrapper = this.fragmentToElement(rendered)
      wrapper.dataset.blockId = model.id
      this.nodes.set(model.id, wrapper)
      this.container.appendChild(wrapper)
    })
  }

  /** Reconcile the keyed projection list; untouched blocks keep their DOM. */
  reconcileBlocks(models: Map<string, BlockModel>, previous: Map<string, BlockModel>): void {
    for (const id of this.nodes.keys()) {
      if (!models.has(id)) this.removeBlockNode(id)
    }
    let preceding: HTMLElement | null = null
    for (const [id, model] of models) {
      let node = this.nodes.get(id)
      if (!node) {
        node = this.fragmentToElement(renderBlock(model, false, this.getRawText?.(id), this.htmlPolicy))
        node.dataset.blockId = id
        this.nodes.set(id, node)
      } else if (previous.get(id) !== model) {
        const expanded = this.expandedBlockId === id
        node.replaceChildren(renderBlock(model, expanded, this.getRawText?.(id), this.htmlPolicy))
        node.classList.toggle('md-block-expanded', expanded)
      }
      const next: ChildNode | null = preceding ? preceding.nextSibling : this.container.firstChild
      if (next !== node) this.container.insertBefore(node, next)
      preceding = node
    }
  }

  fragmentToElement = (fragment: DocumentFragment): HTMLDivElement => {
    const wrapper = document.createElement('div')
    wrapper.classList.add('md-line-block')
    
    wrapper.appendChild(fragment)
    return wrapper
  }

  updateBlock(model: BlockModel) {
    const blockEl = this.nodes.get(model.id)
    if (!blockEl) return

    if (!model.inline) return

    this.syncInline(blockEl, model.inline)
  }

  private syncInline(
    blockEl: HTMLDivElement,
    inlines: InlineModel[]
  ) {
    const domInlines = this.collectInlineDOM(blockEl)

    let domIndex = 0

    for (const inline of inlines) {
      const dom = domInlines[domIndex]
      if (!dom) break

      if (inline.type === 'text') {
        this.syncTextInline(dom, inline)
        domIndex++
      }

      if (inline.type === 'link') {
        this.syncLinkInline(dom, inline)
        domIndex++
      }
    }
  }

  private collectInlineDOM(blockEl: HTMLElement): HTMLElement[] {
    const result: HTMLElement[] = []

    for (const node of blockEl.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        // 包一层虚拟 span 处理
        const span = document.createElement('span')
        span.appendChild(node)
        result.push(span)
      }

      if (node instanceof HTMLElement) {
        result.push(node)
      }
    }

    return result
  }

  private syncTextInline(
    el: HTMLElement,
    inline: TextInline
  ) {
    const textNode = this.getTextNode(el)
    if (!textNode) return

    if (textNode.data !== inline.text) {
      textNode.data = inline.text
    }

    // marks（bold / italic）❌ 输入态不处理
  }

  private syncLinkInline(
    el: HTMLElement,
    inline: LinkInline
  ) {
    if (!(el instanceof HTMLAnchorElement)) return

    // href 在 input 阶段不改
    const textNode = this.getTextNode(el)
    if (!textNode) return

    const text = inline.children
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('')

    if (textNode.data !== text) {
      textNode.data = text
    }
  }

  private getTextNode(el: HTMLElement): Text | null {
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node as Text
      }
    }
    return null
  }

  updateInline(block: BlockModel) {
    const blockEl = this.nodes.get(block.id)
    if (!blockEl || !block.inline) return

    // 遍历 block.inline 对应的 DOM 节点
    const domInlines = Array.from(blockEl.childNodes)

    let inlineIndex = 0

    for (const inline of block.inline) {
      const dom = domInlines[inlineIndex]
      if (!dom) break

      if (!(dom instanceof HTMLElement)) {
        // 不是 HTMLElement 就跳过（通常是 TextNode，可以直接忽略）
        inlineIndex++
        continue
      }

      if (inline.type === 'text') {
        const textNode = this.getTextNode(dom)
        if (textNode && textNode.data !== inline.text) {
          textNode.data = inline.text
        }
        inlineIndex++
      } else if (inline.type === 'link') {
        if (!(dom instanceof HTMLAnchorElement)) continue
        const linkText = inline.children
          .filter(c => c.type === 'text')
          .map(c => c.text)
          .join('')
        const textNode = this.getTextNode(dom)
        if (textNode && textNode.data !== linkText) {
          textNode.data = linkText
        }
        inlineIndex++
      }
    }
  }

  replaceBlock(from: BlockModel, to: BlockModel) {
    const oldEl = this.nodes.get(from.id)
    if (!oldEl) return

    // 保存光标信息
    const selection = window.getSelection()
    const cursorOffset = selection?.focusOffset ?? 0

    // 渲染新的 block
    const fragment = renderBlock(to, false, this.getRawText?.(to.id), this.htmlPolicy)
    const newEl = this.fragmentToElement(fragment)

    oldEl.replaceChildren(...Array.from(newEl.childNodes))

    // 删除旧 id 的映射，将新 id 指向实际挂载在 DOM 中的 oldEl
    this.nodes.delete(from.id)
    oldEl.dataset.blockId = to.id
    this.nodes.set(to.id, oldEl)

    // 尝试恢复光标
    if (selection) {
      const range = document.createRange()
      range.setStart(oldEl, Math.min(cursorOffset, oldEl.childNodes.length))
      range.collapse(true)
      selection.removeAllRanges()
      selection.addRange(range)
    }
  }

  highlightBlock(BlockId: string, type: number, rangePosition?: 'first' | 'middle' | 'last' | 'only') {
    const el = this.nodes.get(BlockId)
    if (!el) return

    this.highLightedBlocks.add(el)
    if (type & BlockVisualState.active) {
      el.classList.add('md-block-active')
    }
    if (type & BlockVisualState.dirty) {
      el.classList.add('md-block-dirty')
    }
    // 跨 Block 连续选区：添加位置类以控制 border-radius
    if (rangePosition && rangePosition !== 'only') {
      el.classList.add(`md-block-range-${rangePosition}`)
    }
  }

  clearHighlight() {
    this.highLightedBlocks.forEach(node => {
      node.classList.remove('md-block-active', 'md-block-range-first', 'md-block-range-middle', 'md-block-range-last')
    })
    this.highLightedBlocks.clear()
  }

  purify() {
    this.highLightedBlocks.forEach(node => {
      if (node.classList.contains('md-block-dirty')) {
        node.classList.remove('md-block-dirty')
        node.classList.add('md-block-active')
      }
    })
  }

  getCurrentCursorVisualOffset(blockId: string, prefixOffset: number): number | null {
    const blockEl = this.nodes.get(blockId)
    if (!blockEl) return null
    const selection = window.getSelection()
    if (!selection) return null
    if (!selection.anchorNode) return null
    if (!blockEl.contains(selection.anchorNode)) return null

    // 如果光标在结构性标记符内（indent、list marker、heading marker），返回 prefixOffset
    if (isInsideStructMarker(selection.anchorNode)) {
      return prefixOffset
    }

    // 找到 md-inline-content 元素
    const inlineContent = blockEl.querySelector('.md-inline-content')
    if (!inlineContent) return null

    // 如果光标不在 inline-content 内，返回 prefixOffset（文本开头）
    if (!inlineContent.contains(selection.anchorNode)) {
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
      if (isInsideMarker(textNode)) {
        if (textNode === selection.anchorNode) {
          // 光标在标记符内，返回当前累积偏移
          return prefixOffset + charOffset
        }
        continue
      }
      if (textNode === selection.anchorNode) {
        return prefixOffset + charOffset + selection.anchorOffset
      }
      charOffset += textNode.textContent?.length ?? 0
    }

    return null
  }

  /**
   * 根据 raw offset（整行原始文本中的偏移，包含标识符）定位光标
   * 遍历 block 内所有文本节点（按 DOM 顺序），累加字符偏移
   */
  /**
   * 强制重置展开状态（不做 DOM 操作，仅清除状态标记）
   * 用于 handleInsertInMarker 场景，避免 expandBlock 因 id 相同而跳过
   */
  forceResetExpanded(): void {
    this.expandedBlockId = null
  }

  /**
   * 直接用展开模式渲染一个 block（不经过 replaceBlock）
   * 用于标识符内部编辑后的重新渲染
   */
  renderBlockExpanded(block: BlockModel): void {
    const blockEl = this.nodes.get(block.id)
    if (!blockEl) return

    // 用展开模式渲染
    const fragment = renderBlock(block, true, this.getRawText?.(block.id), this.htmlPolicy)
    const tempWrapper = document.createElement('div')
    tempWrapper.appendChild(fragment)

    // 替换 blockEl 的子节点
    blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
    blockEl.classList.add('md-block-expanded')

    this.expandedBlockId = block.id
  }

  /**
   * 根据 raw offset（整行原始文本中的偏移，包含标识符）定位光标
   * 
   * 由于展开模式下 DOM 的文本布局可能与原始文本不一致（每个 inline 段有独立的 prefix/suffix），
   * 不能简单遍历 DOM 文本节点。需要先在原始文本中定位到具体的 inline 段和字符位置，
   * 然后在 DOM 中找到对应的文本节点。
   * 
   * 策略：遍历 block 内所有文本节点，按 DOM 顺序累加。
   * 但这里的 rawOffset 是基于 getRawText() 重建的文本，
   * 而 DOM 是基于 renderBlock(block, true) 渲染的。
   * 两者的文本内容一致（都是从同一个 model 生成的），所以可以直接遍历。
   */
  setCursorByRawOffset(blockId: string, rawOffset: number): void {
    const blockEl = this.nodes.get(blockId)
    if (!blockEl) return

    const placeholderRange = resolveRawPlaceholderRange(blockEl, rawOffset)
    if (placeholderRange) {
      applyRange(placeholderRange)
      return
    }

    const walker = document.createTreeWalker(
      blockEl,
      NodeFilter.SHOW_TEXT,
      null
    )

    let accumulated = 0
    let textNode: Text | null
    while ((textNode = walker.nextNode() as Text)) {
      if (isInsideRawPlaceholder(textNode)) continue
      const len = textNode.textContent?.length ?? 0
      if (accumulated + len >= rawOffset) {
        const localOffset = rawOffset - accumulated
        const range = document.createRange()
        range.setStart(textNode, Math.min(localOffset, len))
        range.collapse(true)
        applyRange(range)
        return
      }
      accumulated += len
    }

    // fallback：放到最后一个文本节点的末尾
    const allTextNodes: Text[] = []
    const walker2 = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, null)
    let tn: Text | null
    while ((tn = walker2.nextNode() as Text)) {
      if (isInsideRawPlaceholder(tn)) continue
      allTextNodes.push(tn)
    }
    if (allTextNodes.length > 0) {
      const last = allTextNodes[allTextNodes.length - 1]
      const range = document.createRange()
      range.setStart(last, last.textContent?.length ?? 0)
      range.collapse(true)
      applyRange(range)
    }
  }

  clearCompletionDecoration(): void {
    this.container.querySelectorAll('.md-completion-decoration').forEach(node => node.remove())
  }

  showCompletionDecoration(blockId: string, rawOffset: number, suffix: string): void {
    this.clearCompletionDecoration()
    const position = this.resolveRawOffsetInBlock(blockId, rawOffset)
    if (!position) return

    const decoration = document.createElement('span')
    decoration.className = 'md-completion-decoration'
    decoration.dataset.suffix = suffix
    decoration.contentEditable = 'false'
    decoration.setAttribute('aria-hidden', 'true')

    const range = document.createRange()
    range.setStart(position.node, position.offset)
    range.collapse(true)
    range.insertNode(decoration)
  }

  setCursor(blockId: string, offset: number, prefixOffset: number, direction: 'up' | 'down' | 'current') {
    const block = this.nodes.get(blockId)
    if (!block) return
    if (direction === 'current') {
      const range = resolveRangeFromSemanticOffset(block, offset, prefixOffset)
      applyRange(range)
    } else {
      const nextBlock = direction === 'down' 
        ? findNextLineBlock(block.parentElement!, block) 
        : findPrevLineBlock(block.parentElement!, block)

      if (!nextBlock) return
      const range = resolveRangeFromSemanticOffset(nextBlock, offset, prefixOffset)
      applyRange(range)
    }
  }

  /**
   * 判断上下行移动的目标：是同 block 内移动还是跨 block 移动
   * 返回 { type: 'same-block' } 或 { type: 'cross-block', targetBlockId: string }
   * 用于在移动前先完成展开/收起操作
   */
  getVerticalMoveTarget(blockId: string, direction: 'up' | 'down'): 
    { type: 'same-block' } | { type: 'cross-block'; targetBlockId: string } | null {
    const block = this.nodes.get(blockId)
    if (!block || !block.parentElement) return null

    const LINE_TOLERANCE = 3

    // 检查当前 block 是否有多个视觉行
    const candidates = collectCandidates(block)
    const lines = groupByLine(candidates, LINE_TOLERANCE)

    if (lines.length > 1) {
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const caretRange = sel.getRangeAt(0).cloneRange()
        caretRange.collapse(true)
        const caretRects = caretRange.getClientRects()
        if (caretRects.length > 0) {
          const caretTop = caretRects[0].top
          let currentLineIdx = -1
          for (let i = 0; i < lines.length; i++) {
            if (Math.abs(lines[i][0].rect.top - caretTop) <= LINE_TOLERANCE) {
              currentLineIdx = i
              break
            }
          }
          if (currentLineIdx !== -1) {
            const targetLineIdx = direction === 'down' ? currentLineIdx + 1 : currentLineIdx - 1
            if (targetLineIdx >= 0 && targetLineIdx < lines.length) {
              return { type: 'same-block' }
            }
          }
        }
      }
    }

    // 需要跨 block
    const nextBlock = direction === 'down'
      ? findNextLineBlock(block.parentElement, block)
      : findPrevLineBlock(block.parentElement, block)

    if (!nextBlock) return null

    const targetBlockId = nextBlock.dataset.blockId
    if (!targetBlockId) return null

    return { type: 'cross-block', targetBlockId }
  }

  /**
   * 基于像素 x 坐标实现上下行光标移动
   * 
   * 策略：
   * 1. 先在当前 block 内收集所有可编辑位置，按视觉行分组
   * 2. 找到光标当前所在的视觉行
   * 3. 如果当前 block 内有上/下一个视觉行，就在同 block 内移动
   * 4. 如果已在 block 的第一行/最后一行，则跳到上/下一个 block
   */
  setCursorByPixel(blockId: string, targetX: number, direction: 'up' | 'down') {
    const block = this.nodes.get(blockId)
    if (!block || !block.parentElement) return

    const LINE_TOLERANCE = 3

    // ---- 第一步：尝试在当前 block 内移动 ----
    const currentCandidates = collectCandidates(block)
    const currentLines = groupByLine(currentCandidates, LINE_TOLERANCE)

    if (currentLines.length > 1) {
      // 当前 block 有多个视觉行，找到光标所在行
      const sel = window.getSelection()
      if (sel && sel.rangeCount > 0) {
        const caretRange = sel.getRangeAt(0).cloneRange()
        caretRange.collapse(true)
        const caretRects = caretRange.getClientRects()
        if (caretRects.length > 0) {
          const caretTop = caretRects[0].top
          // 找到光标所在的视觉行索引
          let currentLineIdx = -1
          for (let i = 0; i < currentLines.length; i++) {
            if (Math.abs(currentLines[i][0].rect.top - caretTop) <= LINE_TOLERANCE) {
              currentLineIdx = i
              break
            }
          }

          if (currentLineIdx !== -1) {
            const targetLineIdx = direction === 'down' ? currentLineIdx + 1 : currentLineIdx - 1
            if (targetLineIdx >= 0 && targetLineIdx < currentLines.length) {
              // 同 block 内有目标行，直接在同 block 内移动
              const bestRange = findClosestInLine(currentLines[targetLineIdx], targetX)
              if (bestRange) {
                applyRange(bestRange)
                return
              }
            }
          }
        }
      }
    }

    // ---- 第二步：需要跨 block 移动 ----
    const nextBlock = direction === 'down'
      ? findNextLineBlock(block.parentElement, block)
      : findPrevLineBlock(block.parentElement, block)

    if (!nextBlock) return

    const nextCandidates = collectCandidates(nextBlock)
    if (nextCandidates.length === 0) {
      // fallback：目标 block 没有可编辑位置
      const range = document.createRange()
      range.setStart(nextBlock, 0)
      range.collapse(true)
      applyRange(range)
      return
    }

    const nextLines = groupByLine(nextCandidates, LINE_TOLERANCE)
    if (nextLines.length === 0) return

    // 向下 → 取目标 block 的第一行；向上 → 取目标 block 的最后一行
    const targetLine = direction === 'down' ? nextLines[0] : nextLines[nextLines.length - 1]
    const bestRange = findClosestInLine(targetLine, targetX)

    if (bestRange) {
      applyRange(bestRange)
    }
  }

  updateDOM(block: BlockModel, prefixOffset: number, nextCursorOffset?: number) {
    if (!block || !block.inline) return
    const cursor = this.getCurrentCursorVisualOffset(block.id, prefixOffset)
    const blockEl = this.nodes.get(block.id)
    if (!blockEl) return

    const inlineRoot = blockEl.querySelector('.md-inline-content')
    if (!inlineRoot) return

    // 判断当前 block 是否处于展开状态
    const isExpanded = this.expandedBlockId === block.id

    // ⚠️ 假设 inlineRoot.childNodes 与 block.inline 一一对应
    // （这是你们当前架构下合理的前提）
    const domChildren = Array.from(inlineRoot.childNodes)

    block.inline.forEach((inline, index) => {
      if (!inline.dirty) return

      const oldNode = domChildren[index]
      if (!oldNode) return

      const newNode = renderInlineBlock(inline, isExpanded)

      inlineRoot.replaceChild(newNode, oldNode)

      inline.dirty = false
    })

    if (cursor && nextCursorOffset) {
      this.setCursor(block.id, nextCursorOffset, prefixOffset, 'current')
    }
  }

  getNodeById(BlockId: string): HTMLDivElement | null {
    const el = this.nodes.get(BlockId)
    return el || null
  }

  // private findDocumentRoot(el: HTMLElement | null): HTMLElement | null {
  //   while (el) {
  //     if (el.classList.contains('md-document')) return el
  //     el = el.parentNode as HTMLElement
  //   }
  //   return null
  // }

  insertBlock(origin: BlockModel, target: BlockModel) {
    const el = this.nodes.get(origin.id)
    if (!el) return

    const parent = el.parentNode
    if (!parent) return

    const rendered = renderBlock(target, false, this.getRawText?.(target.id), this.htmlPolicy)
    const wrapper = this.fragmentToElement(rendered)
    wrapper.dataset.blockId = target.id
    this.nodes.set(target.id, wrapper)

    // 插入到 origin 后面
    if (el.nextSibling) {
      parent.insertBefore(wrapper, el.nextSibling)
    } else {
      parent.appendChild(wrapper)
    }
  }

  /**
   * 从 DOM 和 nodes Map 中移除指定 block 节点
   */
  removeBlockNode(blockId: string) {
    const el = this.nodes.get(blockId)
    if (!el) return

    el.parentNode?.removeChild(el)
    this.nodes.delete(blockId)
    this.highLightedBlocks.delete(el)
    this.multiExpandedBlockIds.delete(blockId)
    if (this.expandedBlockId === blockId) this.expandedBlockId = null
  }

  /**
   * 销毁 DOMController，清空所有内部状态和 DOM 节点引用
   */
  destroy() {
    this.container.innerHTML = ''
    this.nodes.clear()
    this.highLightedBlocks.clear()
    this.expandedBlockId = null
    this.multiExpandedBlockIds.clear()
  }

  // ========== Block 级别标记符展开/收起 ==========

  // 当前展开的 block ID（单 block 编辑模式）
  private expandedBlockId: string | null = null
  // 跨 block 选中时展开的 block ID 集合
  private multiExpandedBlockIds: Set<string> = new Set()

  /**
   * 展开多个 block（用于跨 Block 选中场景）
   * 不保存/恢复光标，因为浏览器原生选区会自行管理
   */
  expandMultipleBlocks(blockIds: string[], blocks: Map<string, BlockModel>): void {
    // 先收起单 block 展开模式（不恢复光标）
    if (this.expandedBlockId) {
      const blockEl = this.nodes.get(this.expandedBlockId)
      if (blockEl) {
        const block = blocks.get(this.expandedBlockId)
        if (block) {
          const fragment = renderBlock(block, false, this.getRawText?.(block.id), this.htmlPolicy)
          const tempWrapper = document.createElement('div')
          tempWrapper.appendChild(fragment)
          blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
        }
        blockEl.classList.remove('md-block-expanded')
      }
      this.expandedBlockId = null
    }

    // 只展开新加入的 block，不收起已展开但不在当前范围内的 block
    // （避免拖选缩小时收起 block 导致 DOM 变化破坏选区）
    // 收起操作由 collapseAllMultiExpanded 统一处理（选区结束后调用）
    for (const id of blockIds) {
      if (this.multiExpandedBlockIds.has(id)) continue // 已展开
      const blockEl = this.nodes.get(id)
      const block = blocks.get(id)
      if (!blockEl || !block) continue

      const fragment = renderBlock(block, true, this.getRawText?.(block.id), this.htmlPolicy)
      const tempWrapper = document.createElement('div')
      tempWrapper.appendChild(fragment)
      blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
      blockEl.classList.add('md-block-expanded')
      this.multiExpandedBlockIds.add(id)
    }
  }

  /**
   * 收起所有多 block 展开状态
   */
  collapseAllMultiExpanded(blocks: Map<string, BlockModel>): void {
    for (const id of this.multiExpandedBlockIds) {
      this.collapseOneBlock(id, blocks)
    }
    this.multiExpandedBlockIds.clear()
  }

  /**
   * 是否处于多 block 展开模式
   */
  isMultiExpanded(): boolean {
    return this.multiExpandedBlockIds.size > 0
  }

  /**
   * 指定 block 是否处于多 block 展开模式
   */
  isBlockMultiExpanded(blockId: string): boolean {
    return this.multiExpandedBlockIds.has(blockId)
  }

  /**
   * 收起单个 block（内部辅助方法）
   */
  private collapseOneBlock(blockId: string, blocks: Map<string, BlockModel>): void {
    const blockEl = this.nodes.get(blockId)
    if (!blockEl) return
    const block = blocks.get(blockId)
    if (block) {
      const fragment = renderBlock(block, false, this.getRawText?.(block.id), this.htmlPolicy)
      const tempWrapper = document.createElement('div')
      tempWrapper.appendChild(fragment)
      blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
    }
    blockEl.classList.remove('md-block-expanded')
  }

  /**
   * 根据 raw offset 在指定 block 中找到对应的文本节点和偏移量
   * 返回 { node, offset } 对，用于构建 Selection/Range
   */
  private resolveRawOffsetInBlock(blockId: string, rawOffset: number): { node: Text; offset: number } | null {
    const blockEl = this.nodes.get(blockId)
    if (!blockEl) return null

    const walker = document.createTreeWalker(
      blockEl,
      NodeFilter.SHOW_TEXT,
      null
    )

    let accumulated = 0
    let textNode: Text | null
    while ((textNode = walker.nextNode() as Text)) {
      const len = textNode.textContent?.length ?? 0
      if (accumulated + len >= rawOffset) {
        const localOffset = rawOffset - accumulated
        return { node: textNode, offset: Math.min(localOffset, len) }
      }
      accumulated += len
    }

    // fallback：放到最后一个文本节点的末尾
    const allTextNodes: Text[] = []
    const walker2 = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, null)
    let tn: Text | null
    while ((tn = walker2.nextNode() as Text)) {
      allTextNodes.push(tn)
    }
    if (allTextNodes.length > 0) {
      const last = allTextNodes[allTextNodes.length - 1]
      return { node: last, offset: last.textContent?.length ?? 0 }
    }

    return null
  }

  /**
   * 根据 anchor 和 focus 的 block ID + raw offset 重建跨 block 选区
   * 用于展开所有 block 后恢复精确的选区位置
   */
  setSelectionByRawOffsets(
    anchorBlockId: string, anchorRawOffset: number,
    focusBlockId: string, focusRawOffset: number
  ): void {
    const anchorPos = this.resolveRawOffsetInBlock(anchorBlockId, anchorRawOffset)
    const focusPos = this.resolveRawOffsetInBlock(focusBlockId, focusRawOffset)
    if (!anchorPos || !focusPos) return

    const sel = window.getSelection()
    if (!sel) return

    // 先 collapse 到 anchor 位置，然后 extend 到 focus 位置
    // 这种方式可以正确处理正向和反向选区
    const range = document.createRange()
    range.setStart(anchorPos.node, anchorPos.offset)
    range.collapse(true)
    sel.removeAllRanges()
    sel.addRange(range)
    sel.extend(focusPos.node, focusPos.offset)
  }

  /**
   * 在多个 block 之间创建选区（从 startBlockId 开头到 endBlockId 末尾）
   * 用于展开所有 block 后重建选区
   * @param reversed 是否为反向选区（从下往上选取），默认 false
   */
  selectBlockRange(startBlockId: string, endBlockId: string, reversed: boolean = false): void {
    const startEl = this.nodes.get(startBlockId)
    const endEl = this.nodes.get(endBlockId)
    if (!startEl || !endEl) return

    // 找到起始 block 的第一个文本节点
    const startWalker = document.createTreeWalker(startEl, NodeFilter.SHOW_TEXT, null)
    const firstText = startWalker.nextNode() as Text | null
    if (!firstText) return

    // 找到结束 block 的最后一个文本节点
    const endWalker = document.createTreeWalker(endEl, NodeFilter.SHOW_TEXT, null)
    let lastText: Text | null = null
    let t: Node | null
    while ((t = endWalker.nextNode())) {
      lastText = t as Text
    }
    if (!lastText) return

    const sel = window.getSelection()
    if (!sel) return

    if (reversed) {
      // 反向选区：anchor 在末尾（下方 block），focus 在开头（上方 block）
      // 先 collapse 到末尾位置，然后 extend 到开头位置
      const range = document.createRange()
      range.setStart(lastText, lastText.textContent?.length ?? 0)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
      sel.extend(firstText, 0)
    } else {
      // 正向选区：从开头到末尾
      const range = document.createRange()
      range.setStart(firstText, 0)
      range.setEnd(lastText, lastText.textContent?.length ?? 0)
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }

  /**
   * 展开指定 block 的所有标记符
   * 用展开模式重新渲染整个 block 的 inline 内容
   */
  expandBlock(blockId: string, block: BlockModel): void {
    // 如果已经展开了同一个 block，不重复操作
    if (this.expandedBlockId === blockId) return

    // 先收起之前展开的 block
    this.collapseBlock()

    const blockEl = this.nodes.get(blockId)
    if (!blockEl || !block.inline) return

    // 表格类型特殊处理：计算点击位置对应的 raw text 偏移
    if (block.type === 'table') {
      const rawOffset = this.computeTableClickRawOffset(blockEl, block as TableBlock)
      
      // 用展开模式重新渲染
      const fragment = renderBlock(block, true, this.getRawText?.(block.id), this.htmlPolicy)
      const tempWrapper = document.createElement('div')
      tempWrapper.appendChild(fragment)
      blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
      blockEl.classList.add('md-block-expanded')
      this.expandedBlockId = blockId

      // 用 raw offset 定位光标
      if (rawOffset !== null) {
        this.setCursorByRawOffset(blockId, rawOffset)
      } else {
        // fallback：放到第一个文本节点开头
        this.placeCursorAtFirstText(blockEl)
      }
      return
    }

    if (block.type === 'code-block') {
      const rawOffset = this.computeCodeBlockClickRawOffset(block as CodeBlock)

      const fragment = renderBlock(block, true, this.getRawText?.(block.id), this.htmlPolicy)
      const tempWrapper = document.createElement('div')
      tempWrapper.appendChild(fragment)
      blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
      blockEl.classList.add('md-block-expanded')
      this.expandedBlockId = blockId

      this.setCursorByRawOffset(blockId, rawOffset)
      return
    }

    // 保存光标位置（语义偏移，排除标记符）
    const cursorInfo = this.saveCursorInBlock(blockEl)

    // 用展开模式重新渲染整个 block
    const fragment = renderBlock(block, true, this.getRawText?.(block.id), this.htmlPolicy)
    const tempWrapper = document.createElement('div')
    tempWrapper.appendChild(fragment)

    // 替换 blockEl 的子节点
    blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
    blockEl.classList.add('md-block-expanded')

    this.expandedBlockId = blockId

    // 恢复光标位置
    if (cursorInfo) {
      this.restoreCursorInBlock(blockEl, cursorInfo)
    } else {
      // 无法保存光标位置（如代码块、空行等特殊 block）
      this.placeCursorAtFirstText(blockEl)
    }
  }

  /**
   * 将光标放到 block 中第一个文本节点的开头
   */
  private placeCursorAtFirstText(blockEl: HTMLElement): void {
    const ic = blockEl.querySelector('.md-inline-content') || blockEl.querySelector('.md-table-content')
    if (ic) {
      const walker = document.createTreeWalker(ic, NodeFilter.SHOW_TEXT, null)
      const firstText = walker.nextNode() as Text | null
      if (firstText) {
        const range = document.createRange()
        range.setStart(firstText, 0)
        range.collapse(true)
        applyRange(range)
      }
    }
  }

  private computeCodeBlockClickRawOffset(codeBlock: CodeBlock): number {
    const fence = codeBlock.fence ?? '```'
    return fence.length + codeBlock.language.length
  }

  /**
   * 计算表格非展开模式下点击位置对应的 raw text 偏移
   * 原理：找到 selection 所在的 <th>/<td>，确定行号和列号，
   * 然后在 raw text 中定位到对应单元格的文本位置 + 单元格内偏移
   */
  private computeTableClickRawOffset(blockEl: HTMLElement, tableBlock: TableBlock): number | null {
    const selection = window.getSelection()
    if (!selection || !selection.anchorNode) return null
    if (!blockEl.contains(selection.anchorNode)) return null

    // 找到 selection 所在的 <td> 或 <th>
    const anchorEl = selection.anchorNode instanceof Element 
      ? selection.anchorNode 
      : selection.anchorNode.parentElement
    if (!anchorEl) return null

    const cell = anchorEl.closest('td, th')
    if (!cell) return null

    const row = cell.parentElement as HTMLTableRowElement | null
    if (!row) return null

    // 计算列号
    const colIndex = Array.from(row.cells).indexOf(cell as HTMLTableCellElement)
    if (colIndex === -1) return null

    // 计算行号（0 = 表头行，1+ = 数据行）
    const isHeader = cell.tagName === 'TH'
    let rowIndex: number
    if (isHeader) {
      rowIndex = 0
    } else {
      const tbody = cell.closest('tbody')
      if (!tbody) return null
      const allRows = Array.from(tbody.rows)
      rowIndex = allRows.indexOf(row as HTMLTableRowElement)
      if (rowIndex === -1) return null
      rowIndex += 2 // +2 因为 raw text 中第 0 行是表头，第 1 行是分隔行
    }

    // 计算单元格内的字符偏移
    let cellCharOffset = 0
    if (selection.anchorNode.nodeType === Node.TEXT_NODE) {
      cellCharOffset = selection.anchorOffset
    }

    const slot = isHeader
      ? tableBlock.headerSlots?.[colIndex]
      : tableBlock.rowSlots?.[rowIndex - 2]?.[colIndex]
    if (!slot) return null
    return Math.min(slot.range.to, slot.range.from + cellCharOffset)
  }

  /**
   * 收起当前展开的 block，恢复为正常渲染
   */
  collapseBlock(collapsingBlock?: BlockModel): void {
    if (!this.expandedBlockId) return

    const blockId = this.expandedBlockId
    const blockEl = this.nodes.get(blockId)
    if (!blockEl) {
      this.expandedBlockId = null
      return
    }

    // 保存光标位置（语义偏移，排除标记符）
    const cursorInfo = this.saveCursorInBlock(blockEl)

    // 用正常模式重新渲染
    // 如果调用方提供了 block model，使用它；否则不恢复（由调用方负责）
    if (collapsingBlock) {
      const fragment = renderBlock(collapsingBlock, false, this.getRawText?.(collapsingBlock.id), this.htmlPolicy)
      const tempWrapper = document.createElement('div')
      tempWrapper.appendChild(fragment)
      blockEl.replaceChildren(...Array.from(tempWrapper.childNodes))
    }

    blockEl.classList.remove('md-block-expanded')
    this.expandedBlockId = null

    // 恢复光标位置
    if (cursorInfo && collapsingBlock) {
      this.restoreCursorInBlock(blockEl, cursorInfo)
    }
  }

  /**
   * 获取当前展开的 block ID
   */
  getExpandedBlockId(): string | null {
    return this.expandedBlockId
  }

  /**
   * 保存光标在 block 中的语义位置（排除标记符文本和结构性标记符文本）
   * 返回 { semanticOffset } 或 null
   */
  private saveCursorInBlock(blockEl: HTMLElement): { semanticOffset: number } | null {
    const selection = window.getSelection()
    if (!selection || !selection.anchorNode || !selection.isCollapsed) return null
    if (!blockEl.contains(selection.anchorNode)) return null

    // 检查光标是否在结构性标记符内（indent、list marker、heading marker）
    if (isInsideStructMarker(selection.anchorNode)) {
      // 光标在结构性标记符内，映射到语义偏移 0（文本开头）
      return { semanticOffset: 0 }
    }

    const inlineContent = blockEl.querySelector('.md-inline-content')
    if (!inlineContent) return null
    if (!inlineContent.contains(selection.anchorNode)) return null

    // 遍历 inline-content 中的所有文本节点，跳过 .md-marker 中的文本
    let charOffset = 0
    const walker = document.createTreeWalker(
      inlineContent,
      NodeFilter.SHOW_TEXT,
      null
    )

    let textNode: Text | null
    while ((textNode = walker.nextNode() as Text)) {
      const isMarker = isInsideMarker(textNode)
      if (textNode === selection.anchorNode) {
        if (isMarker) {
          // 光标在 inline 标记符内，映射到最近的语义位置
          const markerEl = textNode.parentElement!
          const expandedSpan = markerEl.parentElement!
          const markers = expandedSpan.querySelectorAll('.md-marker')
          if (markers[0] === markerEl) {
            return { semanticOffset: charOffset }
          } else {
            return { semanticOffset: charOffset }
          }
        }
        return { semanticOffset: charOffset + selection.anchorOffset }
      }
      if (!isMarker) {
        charOffset += textNode.textContent?.length ?? 0
      }
    }

    return null
  }

  /**
   * 在 block 中恢复光标到指定语义偏移位置（跳过标记符文本和结构性标记符文本）
   */
  private restoreCursorInBlock(blockEl: HTMLElement, cursorInfo: { semanticOffset: number }): void {
    const inlineContent = blockEl.querySelector('.md-inline-content')
    if (!inlineContent) return

    const walker = document.createTreeWalker(
      inlineContent,
      NodeFilter.SHOW_TEXT,
      null
    )

    let accumulated = 0
    let textNode: Text | null
    while ((textNode = walker.nextNode() as Text)) {
      if (isInsideMarker(textNode)) continue

      const len = textNode.textContent?.length ?? 0
      if (accumulated + len >= cursorInfo.semanticOffset) {
        const localOffset = cursorInfo.semanticOffset - accumulated
        const range = document.createRange()
        range.setStart(textNode, Math.min(localOffset, len))
        range.collapse(true)
        applyRange(range)
        return
      }
      accumulated += len
    }

    // fallback：放到最后一个非标记符文本节点的末尾
    const allTextNodes: Text[] = []
    const walker2 = document.createTreeWalker(inlineContent, NodeFilter.SHOW_TEXT, null)
    let tn: Text | null
    while ((tn = walker2.nextNode() as Text)) {
      if (!isInsideMarker(tn)) allTextNodes.push(tn)
    }
    if (allTextNodes.length > 0) {
      const last = allTextNodes[allTextNodes.length - 1]
      const range = document.createRange()
      range.setStart(last, last.textContent?.length ?? 0)
      range.collapse(true)
      applyRange(range)
    }
  }

}

export function findNextLineBlock(
  root: HTMLElement,
  current: HTMLElement
): HTMLElement | null {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (
          node instanceof HTMLElement &&
          isLineBlock(node)
        ) {
          return NodeFilter.FILTER_ACCEPT
        }
        return NodeFilter.FILTER_SKIP
      }
    }
  )

  let foundCurrent = false
  let node: Node | null

  while ((node = walker.nextNode())) {
    if (node === current) {
      foundCurrent = true
      continue
    }

    if (foundCurrent) {
      return node as HTMLElement
    }
  }

  return null
}

export function findPrevLineBlock(
  root: HTMLElement,
  current: HTMLElement
): HTMLElement | null {
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode(node) {
        if (
          node instanceof HTMLElement &&
          isLineBlock(node)
        ) {
          return NodeFilter.FILTER_ACCEPT
        }
        return NodeFilter.FILTER_SKIP
      }
    }
  )

  let prev: HTMLElement | null = null
  let node: Node | null

  while ((node = walker.nextNode())) {
    if (node === current) {
      return prev
    }
    prev = node as HTMLElement
  }

  return null
}

function isLineBlock(el: Element): boolean {
  return el.classList.contains('md-line-block')
}

/**
 * 根据语义偏移量在 DOM 中定位光标
 * 语义偏移 = prefixOffset + 文本内字符偏移
 * 
 * 直接在 md-inline-content 中按字符偏移定位，不依赖 resolveDivideRange 的 unit 索引
 * 跳过 .md-marker 中的文本节点
 */
function resolveRangeFromSemanticOffset(
  blockEl: HTMLElement,
  semanticOffset: number,
  prefixOffset: number
): Range {
  const range = document.createRange()

  // 找到 md-inline-content
  const inlineContent = blockEl.querySelector('.md-inline-content')
  if (!inlineContent) {
    // fallback：没有 inline-content，设置到 block 开头
    range.setStart(blockEl, 0)
    range.collapse(true)
    return range
  }

  // 计算文本内偏移
  const textOffset = Math.max(0, semanticOffset - prefixOffset)

  // 遍历 inline-content 中的所有文本节点，找到目标位置
  // 跳过 .md-marker 中的文本节点
  const walker = document.createTreeWalker(
    inlineContent,
    NodeFilter.SHOW_TEXT,
    null
  )

  let accumulated = 0
  let textNode: Text | null
  let lastTextNode: Text | null = null

  while ((textNode = walker.nextNode() as Text)) {
    if (isInsideMarker(textNode)) continue

    lastTextNode = textNode
    const len = textNode.textContent?.length ?? 0

    if (accumulated + len >= textOffset) {
      // 目标位置在这个文本节点内
      const localOffset = textOffset - accumulated
      range.setStart(textNode, Math.min(localOffset, len))
      range.collapse(true)
      return range
    }

    accumulated += len
  }

  // 如果偏移超出了所有文本，放到最后一个文本节点的末尾
  if (lastTextNode) {
    range.setStart(lastTextNode, lastTextNode.textContent?.length ?? 0)
    range.collapse(true)
    return range
  }

  // 最终 fallback
  range.setStart(inlineContent, 0)
  range.collapse(true)
  return range
}

export function resolveDivideRange(
  blockEl: HTMLElement,
): DivideUnit[] {
  const units: DivideUnit[] = []
  let lastOffset = 0

  const pushTextSlots = (textNode: Text, skipLast: boolean = true) => {
    const len = textNode.textContent?.length ?? 0
    for (let i = 0; i < (skipLast ? len : len + 1); i++) {
      units.push({ node: textNode, offset: i })
    }
    if (skipLast) {
      lastOffset = len
    }
  }

  const children = Array.from(blockEl.children)
  children.forEach((el, index) => {
    // 展开模式下的结构性标记符（indent、list marker、heading marker）
    if (el.classList.contains('md-struct-marker')) {
      const textNode = el.firstChild as Text | null
      if (textNode) {
        pushTextSlots(textNode)
      }
      return
    }

    if (el.classList.contains('md-indent') || el.classList.contains('md-spacing')) {
      const textNode = el.firstChild as Text | null
      if (textNode) {
        pushTextSlots(textNode)
      } else {
        // 无子节点时只 push offset: 0，避免 Range.setStart 报 IndexSizeError
        units.push({ node: el, offset: 0, type: 'indent' })
      }
      return
    }

    if (el.classList.contains('md-list-marker') || el.classList.contains('md-list-number')) {
      const textNode = el.firstChild as Text | null
      if (textNode) {
        pushTextSlots(textNode, false)
      }
      return
    }

    if (el.classList.contains('md-list-item')) {
      let marker = el.querySelector('.md-list-marker')
      if (!marker) {
        marker = el.querySelector('.md-list-number')
      }
      const inline = el.querySelector('.md-inline-content')

      if (marker?.firstChild instanceof Text) {
        pushTextSlots(marker.firstChild, false)
      }

      if (inline) {
        const walker = document.createTreeWalker(
          inline,
          NodeFilter.SHOW_TEXT,
          null
        )
        const textNodes: Text[] = []
        let node: Text | null
        while ((node = walker.nextNode() as Text)) {
          textNodes.push(node)
        }

        const lastTextNode = textNodes[textNodes.length - 1]

        for (const textNode of textNodes) {
          const isNotLast = textNode !== lastTextNode
          pushTextSlots(textNode, isNotLast)
        }
      }
      return
    }

    if (el.classList.contains('md-code-block')) {
      const codeContent = el.querySelector('.md-code-block-content') ?? el.querySelector('code')
      if (codeContent) {
        const walker = document.createTreeWalker(
          codeContent,
          NodeFilter.SHOW_TEXT,
          null
        )
        const textNodes: Text[] = []
        let node: Text | null
        while ((node = walker.nextNode() as Text)) {
          textNodes.push(node)
        }

        const lastTextNode = textNodes[textNodes.length - 1]
        for (const textNode of textNodes) {
          const isNotLast = textNode !== lastTextNode
          pushTextSlots(textNode, isNotLast)
        }
      }
      return
    }

    // 数学公式块（展开模式下为 md-math-block > md-math-block-content）
    if (el.classList.contains('md-math-block')) {
      const mathContent = el.querySelector('.md-math-block-content')
      if (mathContent) {
        const walker = document.createTreeWalker(
          mathContent,
          NodeFilter.SHOW_TEXT,
          null
        )
        const textNodes: Text[] = []
        let node: Text | null
        while ((node = walker.nextNode() as Text)) {
          textNodes.push(node)
        }

        const lastTextNode = textNodes[textNodes.length - 1]
        for (const textNode of textNodes) {
          const isNotLast = textNode !== lastTextNode
          pushTextSlots(textNode, isNotLast)
        }
      }
      return
    }

    // 表格（展开模式下为 md-table-wrapper > md-table-content）
    if (el.classList.contains('md-table-wrapper')) {
      const tableContent = el.querySelector('.md-table-content')
      if (tableContent) {
        const walker = document.createTreeWalker(
          tableContent,
          NodeFilter.SHOW_TEXT,
          null
        )
        const textNodes: Text[] = []
        let node: Text | null
        while ((node = walker.nextNode() as Text)) {
          textNodes.push(node)
        }

        const lastTextNode = textNodes[textNodes.length - 1]
        for (const textNode of textNodes) {
          const isNotLast = textNode !== lastTextNode
          pushTextSlots(textNode, isNotLast)
        }
      }
      return
    }

    if (el.classList.contains('md-inline-content')) {
      const walker = document.createTreeWalker(
        el,
        NodeFilter.SHOW_TEXT,
        null
      )
      let textNode: Text | null
      while ((textNode = walker.nextNode() as Text)) {
        pushTextSlots(textNode, index !== children.length - 1)
      }
      return
    }

    // 处理 heading（展开模式下包含 md-struct-marker + md-inline-content，非展开模式下只有 md-inline-content）
    if (el.className.startsWith('md-heading-')) {
      // 遍历 heading 内部的所有子元素
      for (const child of Array.from(el.children)) {
        if (child.classList.contains('md-struct-marker')) {
          const textNode = child.firstChild as Text | null
          if (textNode) {
            pushTextSlots(textNode)
          }
        } else if (child.classList.contains('md-inline-content')) {
          const walker = document.createTreeWalker(
            child,
            NodeFilter.SHOW_TEXT,
            null
          )
          const textNodes: Text[] = []
          let node: Text | null
          while ((node = walker.nextNode() as Text)) {
            textNodes.push(node)
          }
          const lastTextNode = textNodes[textNodes.length - 1]
          for (const textNode of textNodes) {
            const isNotLast = textNode !== lastTextNode
            pushTextSlots(textNode, isNotLast)
          }
        }
      }
      return
    }

    if (el.classList.contains('md-paragraph')) {
      const inline = el.querySelector('.md-inline-content')

      if (inline) {
        const walker = document.createTreeWalker(
          inline,
          NodeFilter.SHOW_TEXT,
          null
        )
        const textNodes: Text[] = []
        let node: Text | null
        while ((node = walker.nextNode() as Text)) {
          textNodes.push(node)
        }

        const lastTextNode = textNodes[textNodes.length - 1]

        for (const textNode of textNodes) {
          const isNotLast = textNode !== lastTextNode
          pushTextSlots(textNode, isNotLast)
        }
      }
    }
  })
  return units
}

// ========== 上下行移动辅助函数 ==========

type Candidate = { range: Range; rect: DOMRect }

function collectCandidates(blockEl: HTMLElement): Candidate[] {
  const units = resolveDivideRange(blockEl)
  // 过滤掉 indent/spacing 等纯装饰性元素、.md-marker 内部的文本节点、以及 .md-struct-marker 内部的文本节点
  const editableUnits = units.filter(u => !u.type && !isInsideMarker(u.node) && !isInsideStructMarker(u.node))
  const result: Candidate[] = []
  for (const unit of editableUnits) {
    const range = document.createRange()
    range.setStart(unit.node, unit.offset)
    range.collapse(true)
    const rects = range.getClientRects()
    if (rects.length === 0) continue
    result.push({ range, rect: rects[0] })
  }
  return result
}

function resolveRawPlaceholderRange(blockEl: HTMLElement, rawOffset: number): Range | null {
  const placeholder = blockEl.querySelector('[data-raw-placeholder]') as HTMLElement | null
  const textNode = placeholder?.firstChild
  if (!placeholder || !(textNode instanceof Text)) return null

  const walker = document.createTreeWalker(blockEl, NodeFilter.SHOW_TEXT, null)
  let accumulated = 0
  let node: Text | null
  while ((node = walker.nextNode() as Text)) {
    if (node === textNode) {
      if (accumulated !== rawOffset) return null
      const range = document.createRange()
      range.setStart(textNode, 0)
      range.collapse(true)
      return range
    }
    if (!isInsideRawPlaceholder(node)) {
      accumulated += node.textContent?.length ?? 0
    }
  }

  return null
}

function groupByLine(candidates: Candidate[], tolerance: number): Candidate[][] {
  if (candidates.length === 0) return []
  const sorted = [...candidates].sort((a, b) => a.rect.top - b.rect.top)
  const lines: Candidate[][] = [[sorted[0]]]
  for (let i = 1; i < sorted.length; i++) {
    const lastLine = lines[lines.length - 1]
    if (Math.abs(sorted[i].rect.top - lastLine[0].rect.top) <= tolerance) {
      lastLine.push(sorted[i])
    } else {
      lines.push([sorted[i]])
    }
  }
  return lines
}

function findClosestInLine(line: Candidate[], targetX: number): Range | null {
  let best: Range | null = null
  let bestDist = Infinity
  for (const { range, rect } of line) {
    const dist = Math.abs(rect.left - targetX)
    if (dist < bestDist) {
      bestDist = dist
      best = range
    }
  }
  return best
}

function applyRange(range: Range) {
  const sel = window.getSelection()
  if (!sel) return

  sel.removeAllRanges()
  sel.addRange(range)
}
