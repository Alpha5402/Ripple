import { Editor } from '../../vendor/mark-it/build/index.js';
import '../../vendor/mark-it/build/index.css';
import 'katex/dist/katex.min.css';

export interface EditorAdapter { getSource(): string; focus(): void; dispose(): void }
export function mountMarkIt(container: HTMLDivElement, source: string, onChange: (source: string) => void): EditorAdapter {
  const editor = new Editor(container, '', source, undefined, { htmlPolicy: 'sanitize' });
  // Mark-it has a separate decorative title. Ripple edits the actual Markdown heading in the body.
  editor.view.title.hidden = true; editor.view.title.contentEditable = 'false';
  editor.view.area.setAttribute('role', 'textbox'); editor.view.area.setAttribute('aria-label', 'Markdown 正文编辑器'); editor.view.area.setAttribute('aria-multiline', 'true');
  editor.onContentChange(onChange);
  return { getSource: () => editor.getMarkdownSource(), focus: () => editor.view.area.focus(), dispose: () => { editor.destroy(); container.replaceChildren(); } };
}
