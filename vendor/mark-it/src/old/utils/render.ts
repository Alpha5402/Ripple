import { LineBlock } from "../types";

export function renderLineContent(
  block: LineBlock,
): DocumentFragment {
  const frag = document.createDocumentFragment();

  if (block.type === 'blank') {
    frag.appendChild(document.createElement('br'));
    return frag;
  }

  if (block.indent) {
    const indent = document.createElement('span');
    indent.className = 'md-indent';
    indent.style.width = `${block.indent}em`;
    frag.appendChild(indent);
  }

  if (block.prefix) {
    const prefix = document.createElement('span');
    prefix.className = block.prefix.className;
    prefix.textContent = block.prefix.text;
    frag.appendChild(prefix);
  }

  if (block.content) {
    const content = document.createElement('span');
    content.className =
      'md-content' +
      (block.content.className ? ' ' + block.content.className : '');

    content.innerHTML = block.content.html;
    frag.appendChild(content);
  }

  return frag;
}
