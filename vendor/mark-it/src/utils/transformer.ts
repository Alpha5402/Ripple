import { EditorActionContext } from '../Editor/EditorEventController'
import { InlineModel } from '../types'

interface InsertAction {
  blockId: string,
  offset: number,
  content: InlineModel
}

interface DeleteAction {
  startBlockId: string
  startOffset: number

  endBlockId: string
  endOffset: number
}

interface SplitAction {
  blockId: string,
  offset: number,
  mode: 'preserve' | 'reset'
}

export type DocumentAction = InsertAction | DeleteAction | SplitAction

export const transform = (ctx: EditorActionContext): DocumentAction | null => {
  if (!ctx.selection) return null

  if (ctx.type === 'delete-backward') {

    const { anchorNode, focusNode, anchorOffset, focusOffset } = ctx.selection
    if (!anchorNode || !focusNode) return null

    const start = findAnchor(anchorNode, anchorOffset)

    const end = findAnchor(focusNode, focusOffset)
    if (!start || !end) return null
    const startBlockId = start.blockId
    const startOffset = start.offset
    const endBlockId = end.blockId
    const endOffset = end.offset

    return {
      startBlockId,
      startOffset,
      endBlockId,
      endOffset
    }
  }

  return null
}

export const findAnchor = (
  node: Node,
  domOffset: number
) => {
  const targetElement =
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement

  const block = targetElement?.closest('.md-line-block') as HTMLDivElement

  if (!block) return null

  const blockId = block.dataset.blockId
  if (!blockId) return null

  const inlineRoot = block.querySelector('.md-inline-content')
  if (!inlineRoot) return null

  let offset = 0

  const walker = document.createTreeWalker(
    inlineRoot,
    NodeFilter.SHOW_TEXT,
    null
  )

  let current: Node | null = walker.nextNode()

  while (current) {
    if (current === node) {
      offset += domOffset
      break
    }
    offset += current.textContent?.length ?? 0
    current = walker.nextNode()
  }

  return {
    blockId,
    offset
  }
}
