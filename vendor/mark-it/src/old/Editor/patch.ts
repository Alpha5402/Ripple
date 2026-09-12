// src/core/patch.ts
import { LineBlock } from "../types";
import { renderLineContent } from '../utils/render'

type CursorSnapshot = {
  id: string;
  offset: number;
} | null;

const saveCursor = (root: HTMLElement): CursorSnapshot => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  // 找到光标所在的 .md-line-block
  const blockEl = range.startContainer.parentElement?.closest('.md-line-block') as HTMLElement;
  
  if (!blockEl || !root.contains(blockEl)) return null;

  const id = blockEl.dataset.id;
  if (!id) return null;

  // 计算相对整个 block 内容的 offset 比较复杂，这里简化处理：
  // 假设光标在 .content 内部。如果你的结构更复杂，这里需要精确计算
  return {
    id,
    offset: range.startOffset 
  };
}

const restoreCursor = (root: HTMLElement, snapshot: CursorSnapshot) => {
  if (!snapshot) return;

  const blockEl = root.querySelector(`[data-id="${snapshot.id}"]`);
  if (!blockEl) return;

  // 找到承载文本的容器，通常是 .content
  const contentEl = blockEl.querySelector('.content'); 
  // 如果 .content 只有纯文本，它的 firstChild 就是 TextNode
  const textNode = contentEl?.firstChild; 

  if (textNode) {
    const sel = window.getSelection();
    if (!sel) return;
    
    // 确保 offset 不越界
    const safeOffset = Math.min(snapshot.offset, (textNode.textContent || '').length);
    
    const range = document.createRange();
    range.setStart(textNode, safeOffset);
    range.collapse(true);
    
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

export const createBlockElement = (block: LineBlock, isPreview: boolean): HTMLElement => {
  const el = document.createElement('div');
  el.dataset.id = block.id.toString();

  if (isPreview) {
    el.className = 'md-line-block';
  }

  el.appendChild(renderLineContent(block));
  return el;
}

const updateBlockElement = (el: HTMLElement, block: LineBlock, isPreview: boolean) => {
  if (!isPreview && block.content) {
    if (el.innerHTML !== block.content.html) {
      el.innerHTML = block.content.html
      el.dataset.id = block.id.toString()
      return el
    } else 
      return
  }
  
  if (block.type === 'blank') {
    if (el.innerHTML !== '<br>') {
      el.innerHTML = '';
      el.appendChild(document.createElement('br'));
    }
    return;
  }

  const br = el.querySelector(':scope > br');
  if (br) {
    br.remove();
  }

  const indentEl = el.querySelector(':scope > .md-indent') as HTMLElement;
  if (block.indent) {
    if (indentEl) {
      if (indentEl.style.width !== `${block.indent}em`) {
        indentEl.style.width = `${block.indent}em`;
      }
    } else {
      const indentEl = document.createElement('span');
      indentEl.className = 'md-indent';
      indentEl.style.width = `${block.indent}em`;
      el.insertBefore(indentEl, el.firstChild);
    }
  } else {
    if (indentEl) {
      indentEl.remove();
    }
  }

  const prefixEl = el.querySelector(':scope > .md-list-marker, :scope > .list-number, :scope > .quote-line'); // 根据你的实际 class 补充
  
  if (block.prefix) {
    if (prefixEl) {
      if (prefixEl.className !== block.prefix.className) prefixEl.className = block.prefix.className;
      if (prefixEl.textContent !== block.prefix.text) prefixEl.textContent = block.prefix.text;
    } else {
      const span = document.createElement('span');
      span.className = block.prefix.className;
      span.textContent = block.prefix.text;
      
      const contentEl = el.querySelector('.md-content');
      if (contentEl) {
        el.insertBefore(span, contentEl);
      } else {
        el.appendChild(span);
      }
    }
  } else if (prefixEl) {
    prefixEl.remove();
  }

  let contentEl = el.querySelector('.md-content') as HTMLElement;
  
  if (!contentEl) {
    contentEl = document.createElement('span');
    contentEl.className = 'md-content' + (block.content?.className ? ' ' + block.content.className : '');
    el.appendChild(contentEl);
  } else {
    const newClass = 'md-content' + (block.content?.className ? ' ' + block.content.className : '');
    if (contentEl.className !== newClass) {
        contentEl.className = newClass;
    }
  }

  if (block.content) {
    if (contentEl.innerHTML !== block.content.html) {
      contentEl.innerHTML = block.content.html;
    }
  } else {
    contentEl.innerHTML = '';
  }
}

export const reconcile = (
  root: HTMLElement, 
  nextBlocks: LineBlock[],
  isPreview: boolean
) => {
  const cursorSnapshot = saveCursor(root);
  const oldNodeMap = new Map<number, HTMLElement>();
  Array.from(root.children).forEach(node => {
    const el = node as HTMLElement;
    if (el.dataset.id) {
      oldNodeMap.set(parseInt(el.dataset.id), el);
    }
  });

  const reusedIds = new Set<number>();

  nextBlocks.forEach((block, index) => {
    reusedIds.add(block.id);

    let el = oldNodeMap.get(block.id);
    if (el) {
      updateBlockElement(el, block, isPreview);
    } else {
      el = createBlockElement(block, isPreview);
    }

    const refNode = root.children[index];

    if (el !== refNode) {
      // insertBefore 的魔力：
      // 如果 el 已经在 DOM 的其他位置，它会被移动过来 (Move)
      // 如果 el 是新创建的，它会被插入
      // 如果 refNode 是 undefined (末尾)，它会 append
      root.insertBefore(el, refNode || null);
    }
  });

  // D. 删除多余节点 (Unmount)
  for (const [id, el] of oldNodeMap) {
    if (!reusedIds.has(id)) {
      el.remove();
    }
  }

  // E. 恢复光标状态
  // 只有当我们在编辑已有行时，且 DOM 结构未发生破坏性变更，光标才能回来
  restoreCursor(root, cursorSnapshot);
}