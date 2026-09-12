import { BlockModel, InlineModel, ListItemBlock, HeadingBlock } from "../types"
import { inlineParse } from "./parse"

export type BlockMatchResult =
  | { type: 'keep'; inline: InlineModel[] }
  | { type: 'transform'; to: BlockModel }


export function matchListItem(
  text: string,
  block: ListItemBlock
): BlockMatchResult {
  // 无序列表
  if (!block.style.ordered) {
    // 支持展开模式的 "- " 前缀和收起模式的 "• " 前缀
    if (text.startsWith('• ') || text.startsWith('- ')) {
      return {
        type: 'keep',
        inline: inlineParse(text.slice(2)).inline
      }
    }

    return {
      type: 'transform',
      to: {
        id: block.id,
        type: 'paragraph',
        inline: inlineParse(text.trimStart()).inline
      }
    }
  }

  // 有序列表
  if (block.style.ordered) {
    const match = text.match(/^(\d+)\.\s+/)
    if (match) {
      return {
        type: 'keep',
        inline: inlineParse(text.slice(match[0].length)).inline
      }
    }

    return {
      type: 'transform',
      to: {
        id: block.id,
        type: 'paragraph',
        inline: inlineParse(text.trimStart()).inline
      }
    }
  }

  return { type: 'keep', inline: block.inline ?? [] }
}

export function matchHeading(
  text: string,
  block: HeadingBlock
): BlockMatchResult {
  // 检查是否仍然是有效的 heading 格式：1-6 个 # 后跟空格
  const match = text.match(/^(#{1,6})\s+(.*)$/)
  if (match) {
    const newDepth = match[1].length
    const content = match[2]
    if (newDepth === block.headingDepth) {
      // 深度不变，只更新 inline
      return {
        type: 'keep',
        inline: inlineParse(content).inline
      }
    } else {
      // 深度变了，需要 transform 为新的 heading
      return {
        type: 'transform',
        to: {
          id: block.id,
          type: 'heading',
          headingDepth: newDepth,
          inline: inlineParse(content).inline,
        } as HeadingBlock
      }
    }
  }

  // heading 结构被破坏，退化为 paragraph
  return {
    type: 'transform',
    to: {
      id: block.id,
      type: 'paragraph',
      inline: inlineParse(text.trimStart()).inline
    }
  }
}
