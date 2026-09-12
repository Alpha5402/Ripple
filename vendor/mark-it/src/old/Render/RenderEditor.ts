import { Renderer } from "./Renderer";
import { parseLine } from '../parser'
import { renderLineContent } from '../utils/render'
import { createBlockElement } from '../Editor/patch'

export function enterEditMode(renderer: Renderer, block: HTMLElement) {
  const id = block.dataset.id!;
  const line = renderer.doc.getLineById(id);
  
  if (!line) return;

  block.classList.add('md-editing');
  block.innerHTML = '';

  const textarea = document.createElement('textarea');
  textarea.className = 'md-line-editor';
  textarea.value = line.raw;

  block.appendChild(textarea);
  textarea.focus();

  let isEnterHandling = false;

  textarea.addEventListener('blur', () => {
    if (isEnterHandling) return;
    exitEditMode(renderer, block, textarea.value);
  });

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();

      isEnterHandling = true;
      const cursor = textarea.selectionStart
      const value = textarea.value

      const before = value.slice(0, cursor)
      const after = value.slice(cursor)

      // 1️⃣ 当前行更新为 before
      renderer.doc.updateLine(id, before)

      // 2️⃣ 插入新行（内容为 after）
      // 4️⃣ 聚焦到新行
      const newLine = renderer.doc.insertLineAfter(id, after);
      if (!newLine) return;

      // 3️⃣ 退出当前编辑态（⚠️ 手动，不走 blur）
      const currentBlock = block; // 你已有的当前行元素
      const currentModel = parseLine(renderer.doc.getLineById(id)!);
      currentBlock.replaceChildren(renderLineContent(currentModel));
      currentBlock.classList.remove('md-editing');

      // 4️⃣ 创建新行 DOM
      const newBlockEl = createBlockElement(parseLine(newLine), true);

      // 5️⃣ 插入新行 DOM（紧邻当前行）
      const parent = currentBlock.parentElement!;
      parent.insertBefore(newBlockEl, currentBlock.nextSibling);
      Array.from(parent.children).forEach((child, index) => {
        (child as HTMLElement).dataset.id = index.toString();
      });

      // 6️⃣ 聚焦到新行
      enterEditMode(renderer, newBlockEl);
    }
  });
}

export function exitEditMode(
  renderer: Renderer,
  block: HTMLElement,
  newRaw: string
) {
  const id = block.dataset.id!;
  
  renderer.doc.updateLine(id, newRaw);

  const line = renderer.doc.getLineById(id)!;
  const blockModel = parseLine(line);

  block.classList.remove('md-editing');
  block.replaceChildren(renderLineContent(blockModel));
}
