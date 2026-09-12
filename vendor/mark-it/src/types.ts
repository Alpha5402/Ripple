export const enum INLINE_FLAG {
  BOLD = 1 << 0,
  ITALIC = 1 << 1,
  HIGHLIGHT = 1 << 2,
  STRIKE = 1 << 3,
  CODE = 1 << 4
}

export const enum BlockVisualState {
  active = 1 << 0,
  dirty = 1 << 2
}

export type RawLine = {
	id: string,
	raw: string,
	leading: string,
}

export type InlineModel =
  | TextInline
  | LinkInline
  | ImageInline
  | FootnoteRefInline
  | MathInline
  | HTMLInline

export type TextInline = {
  type: 'text'
  text: string
  marks: number
  offset: number
  rawStart?: number
  rawEnd?: number
  dirty: boolean
  markers?: { prefix: string; suffix: string }  // 原始 Markdown 标记符，如 { prefix: '**', suffix: '**' }
}

export type LinkInline = {
  type: 'link'
  children: InlineModel[]
  href: string
  marks: number
  offset: number
  rawStart?: number
  rawEnd?: number
  dirty: boolean
}

export type ImageInline = {
  type: 'image'
  alt: string
  src: string
  marks: number
  offset: number
  rawStart?: number
  rawEnd?: number
  dirty: boolean
}

export type BlockModel = {
  id: string
  type: 'paragraph' | 'list-item' | 'heading' | 'hr' | 'blockquote' | 'code-block' | 'table' | 'image' | 'card' | 'blank' | 'math-block' | 'html-block'
  nesting?: number     // 缩进/嵌套
  inline?: InlineModel[]     // 对应文字内容
  children?: BlockModel[]     // 嵌套元素，例如表格行、列表子项
  meta?: any        // 图片 URL / 卡片数据 / 表格属性
}

export interface HeadingBlock extends BlockModel {
  id: string
  type: 'heading'
  headingDepth: number
}

export interface ListItemBlock extends BlockModel {
  id: string
  type: 'list-item'
  style: {
    ordered: true,
    order: string
  } | {
    ordered: false
    bullet?: '-' | '*' | '+'
  } | {
    ordered: false
    task: true
    checked: boolean
    bullet?: '-' | '*' | '+'
    checkedMarker?: 'x' | 'X'
    markerSpacing?: string
  }
}

export interface BlockquoteBlock extends BlockModel {
  id: string
  type: 'blockquote'
  quoteDepth: number  // 引用嵌套层级，> 为 1，>> 为 2
  quoteSpacing?: string // marker 与内容之间的原始空白，保留 `>text` / `> text`
}

export interface CodeBlock extends BlockModel {
  id: string
  type: 'code-block'
  language: string    // 语言标注，如 'javascript'、'python'
  code: string        // 代码内容（原始文本，不做 inline 解析）
  fence?: string      // 原始围栏标记，如 ``` 或 ~~~
  codeLineCount?: number // 代码内容行数；用于区分零行代码和一行空代码
}

export interface TableBlock extends BlockModel {
  id: string
  type: 'table'
  /** 表头行的单元格内容（纯文本） */
  headers: string[]
  /** 对齐方式：'left' | 'center' | 'right' | 'default' */
  aligns: ('left' | 'center' | 'right' | 'default')[]
  /** 数据行，每行是一个单元格数组 */
  rows: string[][]
  /** Inline projections for headers. Ranges are relative to the table block source. */
  headerSlots?: InlineSlot[]
  /** Inline projections for body cells. */
  rowSlots?: InlineSlot[][]
}

export interface InlineSlot {
  raw: string
  range: { from: number; to: number }
  inlines: InlineModel[]
}

export type FootnoteRefInline = {
  type: 'footnote-ref'
  id: string          // 脚注标识符，如 "1" 或 "note"
  marks: number
  offset: number
  rawStart?: number
  rawEnd?: number
  dirty: boolean
}

/** 行内数学公式 $...$ */
export type MathInline = {
  type: 'math'
  tex: string         // LaTeX 源码
  marks: number
  offset: number
  rawStart?: number
  rawEnd?: number
  dirty: boolean
}

/** 块级数学公式 $$...$$ */
export interface MathBlock extends BlockModel {
  id: string
  type: 'math-block'
  tex: string         // LaTeX 源码
  texLineCount?: number // 内容行数；用于区分 "$$\n$$" 和 "$$\n\n$$"
  singleLine?: boolean // 是否使用 "$$...$$" 单行块格式
}

export type HTMLInline = {
  type: 'html-inline'
  raw: string
  marks: number
  offset: number
  rawStart: number
  rawEnd: number
  dirty: boolean
}

export interface HTMLBlock extends BlockModel {
  id: string
  type: 'html-block'
  raw: string
  inline: []
}

export type HTMLPolicy = 'sanitize' | 'escape' | 'trusted'

export interface FootnoteDefBlock extends BlockModel {
  id: string
  type: 'paragraph'   // 复用 paragraph 类型，通过 footnoteId 区分
  footnoteId: string  // 脚注标识符
  footnoteSpacing?: string // 冒号与正文之间的原始空白
}

export interface DivideUnit {
  node: Node
  offset: number
  type?: string
}

/** 文档元数据，用于在标题下方展示作者、更新时间等信息 */
export interface DocumentMetadata {
  /** 元数据条目，每项为一个 label-value 对 */
  items: { label: string; value: string }[]
}
