// src/index.ts

// 1. 导出类型 (Types)
export * from './types';

import './styles/main.css';
import 'katex/dist/katex.min.css';

// 3. 导出核心纯函数 (Core Functions) - 方便硬核用户自己写框架适配器
// export { tokenizeLine } from './tokenizer';
// export { parseLine } from './parser';
// export { reconcile } from './Editor/patch'; // 刚才写的 DOM Diff 核心
// export { tokenize } from './tokenize';

export { Editor, type EditorOptions } from './Editor/Editor';
export { Renderer, type RendererOptions } from './Renderer/Renderer'
