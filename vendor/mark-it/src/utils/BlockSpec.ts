import type {
  BlockModel,
  HTMLPolicy,
  InlineSlot
} from '../types'
import type { SourceRange } from './SourceDocument'
import { parseLine } from './parse'
import { renderBlock } from './render'
import { renderBlockHTML } from './html'
import { initialTokenizeWithRanges } from './tokenize'

export type BlockContentModel = 'literal' | 'inline' | 'inline-slots' | 'blocks'

export interface ScanContext {
  source: string
  offset: number
}

export interface BlockProjection<T extends BlockModel = BlockModel> {
  id: string
  range: SourceRange
  /** Exact canonical source slice for this projection. */
  raw: string
  model: T
  slots: InlineSlot[]
}

export interface BlockSpec<T extends BlockModel = BlockModel> {
  type: T['type']
  contentModel: BlockContentModel
  scan(context: ScanContext): SourceRange | null
  parse(source: string, range: SourceRange, id: string): T
  render(projection: BlockProjection<T>, mode: 'expanded' | 'preview', policy: HTMLPolicy): Node
  renderHTML(projection: BlockProjection<T>, policy: HTMLPolicy): string
}

export class BlockSpecRegistry {
  private readonly specs = new Map<BlockModel['type'], BlockSpec>()

  register<T extends BlockModel>(spec: BlockSpec<T>): void {
    if (this.specs.has(spec.type)) {
      throw new Error(`Block spec already registered: ${spec.type}`)
    }
    this.specs.set(spec.type, spec as BlockSpec)
  }

  get<T extends BlockModel>(type: T['type']): BlockSpec<T> | null {
    return (this.specs.get(type) as BlockSpec<T> | undefined) ?? null
  }
}

function createSourceSpec<T extends BlockModel>(
  type: T['type'],
  contentModel: BlockContentModel
): BlockSpec<T> {
  return {
    type,
    contentModel,
    scan({ source, offset }) {
      return initialTokenizeWithRanges(source)
        .find(token => token.range.from <= offset && token.range.to >= offset)
        ?.range ?? null
    },
    parse(source, range, id) {
      const raw = source.slice(range.from, range.to).replace(/\r\n?|\n/g, '\n')
      const parsed = parseLine({
        id,
        raw,
        leading: raw.match(/^[ \t]*/)?.[0] ?? ''
      })
      if (parsed.type !== type) {
        throw new Error(`Expected ${type}, parsed ${parsed.type}`)
      }
      return parsed as T
    },
    render(projection, mode, policy) {
      return renderBlock(projection.model, mode === 'expanded', projection.raw, policy)
    },
    renderHTML(projection, policy) {
      return renderBlockHTML(projection.model, policy)
    }
  }
}

export const coreBlockSpecs = new BlockSpecRegistry()
coreBlockSpecs.register(createSourceSpec('table', 'inline-slots'))
coreBlockSpecs.register(createSourceSpec('html-block', 'literal'))
