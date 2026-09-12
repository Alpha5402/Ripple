export type TokenType = 
  | 'heading' 
  | 'paragraph' 
  | 'blockquote' 
  | 'list'       // 无序列表容器 <ul>
  | 'list-item'  // 无序列表项 <li>
  | 'ordered-list' // 🔥 新增：有序列表容器 <ol>
  | 'ordered-list-item' // 🔥 新增：有序列表项
  | 'code-block';

export type Token = {
      type: 'heading';
      level: number;
      content: string;
    }
  | {
      type: 'list-item';
      ordered: boolean;
      indent: number;
      content: string;
      order?: number;
    }
  | {
      type: 'paragraph';
      indent: number;
      content: string;
    }
  | {
      type: 'blank';
    };

export interface LineModel {
  id: number
  raw: string
  indent: number
  leadingSpaces: number
}

export type LineBlock = {
  id: number
  type: 
  'paragraph' | 
  'heading' | 
  'list-item' | 
  'code' | 
  'quote' |
  'blank'

  indent?: number

  prefix?: {
    text: string
    className: string
    width?: number
  }

  content?: {
    html: string
    className?: string
  }

  className?: string

  level?: number
}


export interface DocLine {
  id: string
  raw: string
}

export interface DocumentState {
  lines: DocLine[]
}

export type PatchOp =
  | { type: 'mount'; block: LineBlock; index: number }
  | { type: 'patch'; block: LineBlock }
  | { type: 'unmount'; id: string }

const enum FLAG {
  BOLD = 0,
  ITALIC = 1,
  HIGHLIGHT = 2,
  DELETE = 3
} 