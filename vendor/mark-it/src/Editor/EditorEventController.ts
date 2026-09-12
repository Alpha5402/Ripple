export enum EditorActionType {
  InsertText = 'insert-text',
  DeleteBackward = 'delete-backward',
  DeleteForward = 'delete-forward',
  InsertLineBreak = 'insert-line-break',
  SelectionChange = 'selection-change',
  MoveCursorDown = 'move-cursor-down',
  MoveCursorUp = 'move-cursor-up',
  Enter = 'enter',

  Select = 'select',

  Copy = 'copy',
  Cut = 'cut',
  Paste = 'paste',

  CompositionStart = 'composition-start',
  CompositionUpdate = 'composition-update',
  CompositionEnd = 'composition-end',

  Undo = 'undo',
  Redo = 'redo',

  /** 格式化快捷键：data 为 'bold' | 'italic' | 'strikethrough' | 'code' | 'highlight' | 'link' */
  FormatToggle = 'format-toggle',
  /** Tab 缩进 */
  Indent = 'indent',
  /** Shift+Tab 反缩进 */
  Outdent = 'outdent',
  /** 拖拽文件（图片等）到编辑区 */
  Drop = 'drop',
  /** 点击链接 */
  LinkClick = 'link-click',
  /** 鼠标悬停图片 */
  ImageHover = 'image-hover',
  /** Cmd+点击脚注引用，跳转到脚注定义 */
  FootnoteJump = 'footnote-jump',
  /** 点击文档末尾空白区域 */
  BlankAreaClick = 'blank-area-click',
  CancelCompletion = 'cancel-completion',

  DomMutated = 'dom-mutated',

  Unknown = 'unknown'
}

export interface SelectionSnapshot {
  anchorNode: Node | null
  anchorOffset: number
  focusNode: Node | null
  focusOffset: number
  isCollapsed: boolean
}

export interface EditorActionContext {
  type: EditorActionType
  selection: SelectionSnapshot | null
  nativeEvent: Event | null

  prevSelection?: SelectionSnapshot | null
  data?: string | null
  inputType?: string

  /** DOM 变化（仅 MutationObserver 使用） */
  mutations?: MutationRecord[]

  /** 拖拽的文件列表 */
  files?: FileList | null

  /** 被点击的链接元素 */
  linkElement?: HTMLAnchorElement | null

  timestamp: number
}

export class EventController {
  private isComposing = false
  private mutationObserver: MutationObserver | null = null
  
  // 记录“上一次”的选区，用于 diff
  private lastSelectionSnapshot: SelectionSnapshot | null = null
  
  private inInputTransaction = false
  private pendingMutations: MutationRecord[] = []

  // 记住连续上下移动时的初始 x 坐标，避免光标漂移
  private stickyX: number | null = null
  // 标记当前选区变化是否由上下键移动引起，避免 selectionchange 清除 stickyX
  private isVerticalMove = false

  constructor(
    private readonly root: HTMLElement,
    private readonly onAction: (ctx: EditorActionContext) => void
  ) {
    this.bind()
    this.initMutationObserver()
    // 初始化选区状态
    this.lastSelectionSnapshot = this.captureSelection()
  }

  destroy() {
    this.unbind()
    this.mutationObserver?.disconnect()
  }

  // -------------------------
  // Bind / Unbind
  // -------------------------

  private bind() {
    this.root.addEventListener('beforeinput', this.onBeforeInput)
    this.root.addEventListener('focusout', this.onFocusOut)
    this.root.addEventListener('input', this.onInput)
    this.root.addEventListener('keydown', this.onKeyDown)

    document.addEventListener('selectionchange', this.onSelectionChange)

    this.root.addEventListener('copy', this.onCopy)
    this.root.addEventListener('cut', this.onCut)
    this.root.addEventListener('paste', this.onPaste)

    this.root.addEventListener('compositionstart', this.onCompositionStart)
    this.root.addEventListener('compositionupdate', this.onCompositionUpdate)
    this.root.addEventListener('compositionend', this.onCompositionEnd)

    this.root.addEventListener('dragover', this.onDragOver)
    this.root.addEventListener('drop', this.onDrop)
    this.root.addEventListener('mousedown', this.onMouseDown)
    this.root.addEventListener('mouseover', this.onMouseOver)
  }

  private unbind() {
    this.root.removeEventListener('beforeinput', this.onBeforeInput)
    this.root.removeEventListener('focusout', this.onFocusOut)
    this.root.removeEventListener('input', this.onInput)
    this.root.removeEventListener('keydown', this.onKeyDown)
    document.removeEventListener('selectionchange', this.onSelectionChange)

    this.root.removeEventListener('copy', this.onCopy)
    this.root.removeEventListener('cut', this.onCut)
    this.root.removeEventListener('paste', this.onPaste)

    this.root.removeEventListener('compositionstart', this.onCompositionStart)
    this.root.removeEventListener('compositionupdate', this.onCompositionUpdate)
    this.root.removeEventListener('compositionend', this.onCompositionEnd)

    this.root.removeEventListener('dragover', this.onDragOver)
    this.root.removeEventListener('drop', this.onDrop)
    this.root.removeEventListener('mousedown', this.onMouseDown)
    this.root.removeEventListener('mouseover', this.onMouseOver)
  }

  // -------------------------
  // Selection
  // -------------------------

  private isSelectionInEditor(): boolean {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return false
    const node = sel.anchorNode
    // 向上查找是否包含在 root 内
    return node ? this.root.contains(node.nodeType === 1 ? node : node.parentNode) : false
  }

  private captureSelection(): SelectionSnapshot | null {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0) return null

    return {
      anchorNode: sel.anchorNode,
      anchorOffset: sel.anchorOffset,
      focusNode: sel.focusNode,
      focusOffset: sel.focusOffset,
      isCollapsed: sel.isCollapsed
    }
  }

  // -------------------------
  // Emit
  // -------------------------

  private emit(
    type: EditorActionType,
    nativeEvent: Event | null,
    extra?: Partial<EditorActionContext>
  ) {
    this.onAction({
      type,
      nativeEvent,
      selection: this.captureSelection(),
      timestamp: performance.now(),
      ...extra
    })
  }

  // -------------------------
  // Mutation Observer
  // -------------------------

  private initMutationObserver() {
    this.mutationObserver = new MutationObserver(mutations => {
      if (!this.inInputTransaction) return

      this.pendingMutations.push(...mutations)
    })

    this.mutationObserver.observe(this.root, {
      childList: true,
      characterData: true,
      subtree: true
    })
  }

  // -------------------------
  // Input lifecycle
  // -------------------------

  private onBeforeInput = (e: InputEvent) => {
    if (this.isComposing) return
    e.preventDefault()

    // 输入操作清除 stickyX
    this.stickyX = null

    // 1. 捕捉动作前的状态
    const beforeSelection = this.captureSelection()
    this.lastSelectionSnapshot = beforeSelection // 更新缓存
    
    this.inInputTransaction = true
    this.pendingMutations = []

    switch (e.inputType) {
      case 'insertText':
        this.emit(EditorActionType.InsertText, e, {
          data: e.data,
          inputType: e.inputType,
          prevSelection: beforeSelection
        })
        break

      case 'deleteContentBackward':
        this.emit(EditorActionType.DeleteBackward, e, {
          inputType: e.inputType,
          prevSelection: beforeSelection
        })
        break

      case 'deleteContentForward':
        this.emit(EditorActionType.DeleteForward, e, {
          inputType: e.inputType,
          prevSelection: beforeSelection
        })
        break

      // 💡 改进 2: 增加对标准换行 (Enter) 的支持
      case 'insertParagraph': 
        this.emit(EditorActionType.InsertLineBreak, e, {
          inputType: e.inputType,
          prevSelection: beforeSelection,
          data: '\n' // 显式标记为换行符
        })
        break;

      case 'insertLineBreak': // Shift + Enter
        this.emit(EditorActionType.InsertLineBreak, e, {
          inputType: e.inputType,
          prevSelection: beforeSelection,
          data: '\n'
        })
        break

      default:
        // 对于粘贴、拖拽等操作，也可以先作为一个 Unknown 或 GenericInput 抛出去
        this.emit(EditorActionType.Unknown, e, {
          inputType: e.inputType,
          prevSelection: beforeSelection
        })
    }

    // preventDefault() 阻止了浏览器默认输入行为，input 事件不会触发，
    // 所以需要在这里手动重置 inInputTransaction，否则 onKeyDown 会被永久阻塞
    this.inInputTransaction = false
    this.pendingMutations = []
  }

  private onInput = (e: Event) => {
    // 处理 Mutation（如果有）
    if (this.pendingMutations.length > 0) {
      this.emit(EditorActionType.DomMutated, e, {
        mutations: this.pendingMutations.slice(),
        prevSelection: this.lastSelectionSnapshot
      })
    }
    
    // input 结束后，更新一下最新的选区快照
    this.lastSelectionSnapshot = this.captureSelection()
    
    this.inInputTransaction = false
    this.pendingMutations = []
  }

  // -------------------------
  // Keyboard fallback
  // -------------------------

  private onKeyDown = (e: KeyboardEvent) => {
    if (this.inInputTransaction) return

    // WebKit may report insertParagraph even for Shift+Enter. Resolve the
    // explicit key gesture here and suppress its native beforeinput to avoid
    // a second edit. IME confirmation must remain owned by the input method.
    if (e.key === 'Enter' && e.shiftKey) {
      if (this.isComposing || e.isComposing || e.keyCode === 229) return
      e.preventDefault()
      this.stickyX = null
      this.emit(EditorActionType.InsertLineBreak, e, {
        inputType: 'insertLineBreak',
        data: '\n'
      })
      return
    }

    if (e.key === 'Escape') {
      e.preventDefault()
      this.emit(EditorActionType.CancelCompletion, e)
      return
    }

    // The editor area is one contenteditable root containing many source blocks.
    // Native Cmd/Ctrl+A therefore places the range endpoints on that outer root,
    // where model-driven deletion cannot resolve a block and silently does
    // nothing. Keep "select all" scoped to the current source block so the
    // following Copy/Cut/Delete operation always has lossless raw offsets.
    if (
      (e.metaKey || e.ctrlKey) &&
      !e.altKey &&
      e.key.toLowerCase() === 'a'
    ) {
      const selection = window.getSelection()
      const blockEl = selection?.anchorNode
        ? getBlockAnchor(selection.anchorNode)
        : null
      if (!selection || !blockEl) return

      e.preventDefault()
      const walker = document.createTreeWalker(
        blockEl,
        NodeFilter.SHOW_TEXT,
        null
      )
      const textNodes: Text[] = []
      let textNode: Text | null
      while ((textNode = walker.nextNode() as Text | null)) {
        textNodes.push(textNode)
      }

      const range = document.createRange()
      const first = textNodes[0]
      const last = textNodes[textNodes.length - 1]
      if (first && last) {
        range.setStart(first, 0)
        range.setEnd(last, last.data.length)
      } else {
        range.selectNodeContents(blockEl)
      }
      selection.removeAllRanges()
      selection.addRange(range)
      this.lastSelectionSnapshot = this.captureSelection()
      this.stickyX = null
      return
    }

    // 拦截左右键：跳过 struct-marker 与相邻元素之间的 DOM 边界幽灵位置
    // 同时补齐浏览器默认编辑体验：Shift 扩展选区，Option/Cmd 按词/行边界移动。
    // 注意：struct-marker 内部的字符位置是正常的，用户应该能在其中移动
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      const sel = window.getSelection()
      if (!sel) return

      const direction = e.key === 'ArrowRight' ? 'forward' : 'backward'
      const alter = e.shiftKey ? 'extend' : 'move'
      const granularity = e.metaKey ? 'lineboundary' : e.altKey ? 'word' : 'character'

      if (granularity !== 'character') {
        sel.modify(alter, direction, granularity)
        this.stickyX = null
        return
      }

      // 获取移动前的视觉位置
      let prevRect = getSelectionFocusRect(sel)

      // 循环移动，跳过所有幽灵位置
      const MAX_ITERATIONS = 20
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        sel.modify(alter, direction, granularity)
        if (!sel.focusNode) break

        // 情况 1：光标落在 ELEMENT_NODE 上（DOM 边界幽灵位置），继续移动
        if (sel.focusNode.nodeType === Node.ELEMENT_NODE) {
          continue
        }

        // 情况 2：光标在文本节点内，检查视觉位置是否发生了变化
        const curRect = getSelectionFocusRect(sel)
        if (prevRect && curRect) {
          // 如果视觉位置没有变化（x 坐标差 < 1px），说明是幽灵位置，继续移动
          if (Math.abs(curRect.left - prevRect.left) < 1 && Math.abs(curRect.top - prevRect.top) < 1) {
            prevRect = curRect
            continue
          }
        }

        // 视觉位置发生了变化，这是一个有效的光标位置，停止
        break
      }

      // 清除 stickyX
      this.stickyX = null
      return
    }

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const selection = window.getSelection()
      if (!selection || !selection.anchorNode) return

      const blockEl = getBlockAnchor(selection.anchorNode)
      if (!blockEl) return

      const caretRect = getCaretRect(selection)
      if (!caretRect) return

      // 始终拦截上下键，避免浏览器默认行为在 flex 布局中产生异常
      e.preventDefault()

      // 首次按上下键时记住 x 坐标，连续上下移动时复用，避免光标漂移
      if (this.stickyX === null) {
        this.stickyX = caretRect.left
      }

      // 标记为垂直移动，防止 selectionchange 清除 stickyX
      this.isVerticalMove = true

      const direction = e.key === 'ArrowDown' ? 'down' : 'up'
      this.emit(
        direction === 'down' ? EditorActionType.MoveCursorDown : EditorActionType.MoveCursorUp,
        null,
        { data: String(this.stickyX) }
      )
      return
    }

    // 非上下键操作，清除 stickyX
    this.stickyX = null

    // Tab / Shift+Tab：缩进/反缩进
    if (e.key === 'Tab') {
      e.preventDefault()
      this.stickyX = null
      if (e.shiftKey) {
        this.emit(EditorActionType.Outdent, e)
      } else {
        this.emit(EditorActionType.Indent, e)
      }
      return
    }

    // Undo: Ctrl+Z / Cmd+Z
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      e.preventDefault()
      this.emit(EditorActionType.Undo, e)
      return
    }

    // Redo: Ctrl+Shift+Z / Cmd+Shift+Z 或 Ctrl+Y / Cmd+Y
    if (((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') ||
        ((e.ctrlKey || e.metaKey) && e.key === 'y')) {
      e.preventDefault()
      this.emit(EditorActionType.Redo, e)
      return
    }
  }

  private onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget
    if (next instanceof Node && this.root.contains(next)) return
    this.emit(EditorActionType.CancelCompletion, event)
  }

  // -------------------------
  // Selection
  // -------------------------

  private onSelectionChange = () => {
    if (!this.isSelectionInEditor()) return

    // 上下键移动引起的选区变化，跳过 stickyX 清除
    if (this.isVerticalMove) {
      this.isVerticalMove = false
    } else {
      // 鼠标点击等非上下键操作导致的选区变化，清除 stickyX
      this.stickyX = null
    }

    const current = this.captureSelection()
    this.emit(EditorActionType.Select, null, {
        selection: current,
        prevSelection: this.lastSelectionSnapshot
    })
    
    this.lastSelectionSnapshot = current
  }

  // -------------------------
  // Clipboard
  // -------------------------

  private onCopy = (e: ClipboardEvent) => {
    e.preventDefault()
    this.emit(EditorActionType.Copy, e)
  }

  private onCut = (e: ClipboardEvent) => {
    e.preventDefault()
    this.emit(EditorActionType.Cut, e)
  }

  private onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    this.emit(EditorActionType.Paste, e, {
      data: e.clipboardData?.getData('text/plain') ?? null
    })
  }

  // -------------------------
  // IME
  // -------------------------

  private onCompositionStart = (e: CompositionEvent) => {
    this.isComposing = true
    this.emit(EditorActionType.CompositionStart, e)
  }

  private onCompositionUpdate = (e: CompositionEvent) => {
    this.emit(EditorActionType.CompositionUpdate, e)
    e.preventDefault()
  }

  private onCompositionEnd = (e: CompositionEvent) => {
    this.isComposing = false
    this.emit(EditorActionType.CompositionEnd, e, {
      data: e.data
    })
  }

  // -------------------------
  // Drag & Drop
  // -------------------------

  private onDragOver = (e: DragEvent) => {
    e.preventDefault()
  }

  private onDrop = (e: DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      this.stickyX = null
      this.emit(EditorActionType.Drop, e, { files })
    }
  }

  // -------------------------
  // MouseDown（Cmd+点击跳转链接）
  // -------------------------

  private onMouseDown = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target) return

    if (e.button === 0 && target === this.root) {
      const blocks = Array.from(this.root.querySelectorAll<HTMLElement>('.md-line-block'))
      const lastBlock = blocks[blocks.length - 1]
      if (!lastBlock || e.clientY >= lastBlock.getBoundingClientRect().bottom) {
        e.preventDefault()
        this.stickyX = null
        this.emit(EditorActionType.BlankAreaClick, e)
        return
      }
    }

    // Cmd（Mac）或 Ctrl（Windows/Linux）+ 左键点击
    if ((e.metaKey || e.ctrlKey) && e.button === 0) {
      // 脚注引用跳转
      const footnoteLink = target.closest('a.md-footnote-link') as HTMLElement | null
      if (footnoteLink && this.root.contains(footnoteLink)) {
        e.preventDefault()
        e.stopPropagation()
        const footnoteId = footnoteLink.dataset.footnoteId || ''
        if (footnoteId) {
          this.emit(EditorActionType.FootnoteJump, e, { data: footnoteId })
        }
        return
      }

      // 普通链接跳转
      const linkEl = target.closest('a.md-link') as HTMLAnchorElement | null
      if (linkEl && this.root.contains(linkEl)) {
        e.preventDefault()
        e.stopPropagation()
        const href = linkEl.getAttribute('href') || linkEl.href || ''
        if (href) {
          window.open(href, '_blank')
        }
      }
    }
  }

  // -------------------------
  // MouseOver（链接 hover 弹窗）
  // -------------------------

  private onMouseOver = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    if (!target) return

    // 链接 hover
    const linkEl = target.closest('a.md-link') as HTMLAnchorElement | null
    if (linkEl && this.root.contains(linkEl)) {
      const rect = linkEl.getBoundingClientRect()
      const href = linkEl.getAttribute('href') || ''
      const text = linkEl.textContent || ''
      const blockEl = linkEl.closest('.md-line-block') as HTMLElement | null
      const blockId = blockEl?.dataset?.blockId || ''

      this.emit(EditorActionType.LinkClick, e, {
        linkElement: linkEl,
        data: JSON.stringify({ href, text, blockId, rect: { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right } })
      })
      return
    }

    // 图片 hover
    if (target.tagName === 'IMG' && target.classList.contains('md-image') && this.root.contains(target)) {
      const imgEl = target as HTMLImageElement
      const rect = imgEl.getBoundingClientRect()
      const src = imgEl.getAttribute('src') || ''
      const alt = imgEl.getAttribute('alt') || ''
      const blockEl = imgEl.closest('.md-line-block') as HTMLElement | null
      const blockId = blockEl?.dataset?.blockId || ''

      this.emit(EditorActionType.ImageHover, e, {
        data: JSON.stringify({ src, alt, blockId, rect: { left: rect.left, top: rect.top, bottom: rect.bottom, right: rect.right } })
      })
    }
  }
}




function getCaretRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0).cloneRange()
  range.collapse(true)

  const rects = range.getClientRects()
  if (rects.length > 0) {
    return rects[0]
  }

  return range.getBoundingClientRect()
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
 * 获取当前光标的视觉位置矩形
 * 用于检测 sel.modify 后光标是否真的发生了视觉移动
 */
function getCaretVisualRect(sel: Selection): DOMRect | null {
  if (sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0).cloneRange()
  range.collapse(true)
  const rects = range.getClientRects()
  if (rects.length > 0) return rects[0]
  return range.getBoundingClientRect()
}

function getSelectionFocusRect(sel: Selection): DOMRect | null {
  if (!sel.focusNode) return getCaretVisualRect(sel)

  const range = document.createRange()
  range.setStart(sel.focusNode, sel.focusOffset)
  range.collapse(true)
  const rects = range.getClientRects()
  if (rects.length > 0) return rects[0]
  return range.getBoundingClientRect()
}
