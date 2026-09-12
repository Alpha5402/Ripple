import { DocumentController } from '../utils/DocumentController';
import { renderDocument } from './renderDocument'
import { EditorView } from './EditorView'
import { EditorController } from './EditorController'
import { LineModel } from '../types';
import { escapeHTML } from '../parser';
import { reconcile } from './patch';

export class MarkdownEditor {
  view: EditorView;
  doc: DocumentController;
  private onChange?: (content: string) => void;
  constructor(
    editorContainer: HTMLDivElement,
    previewContainer: HTMLDivElement,
    initialContent: string = ''
  ) {
    this.view = new EditorView(editorContainer, previewContainer, initialContent)

    EditorController(this)
    this.doc = new DocumentController()
    this.updatePreview(initialContent);
  }

  destroy() {
    this.view.destroy()
  }

  private updatePreview(content: string) {
    const lines = this.doc.update(content)

    renderDocument(this.view.previewArea, lines)
    this.renderEditorLines(this.view.editorPreviewContainer, lines)
  }

  renderEditorLines(
    root: HTMLElement,
    lines: LineModel[]
  ) {
    const blocks = lines.map(line => ({
      id: line.id,
      type: 'paragraph' as const,
      content: {
        html: line.raw === '' ? '&nbsp;' : escapeHTML(line.raw)
      }
    }))

    reconcile(root, blocks, false)
  }

  handleInput() {
    const content = this.view.getValue()
    this.updatePreview(content)
    this.onChange?.(content)
  }

  handleScroll() {
    this.view.syncScroll()
  }

  handleCursorChange() {
    this.syncHighlight()
  }
  getCursorLineIndex = () => {
    const cursorIndex = this.view.editorArea.selectionStart;
    const textBeforeCursor = this.view.editorArea.value.substring(0, cursorIndex);
    return textBeforeCursor.split('\n').length - 1;
  };

  syncHighlight = () => {
    const currentIndex = this.getCursorLineIndex()
    this.view.previewArea.querySelectorAll(`.active-line`)?.forEach(el => el.classList.remove('active-line'));
    this.view.editorPreviewContainer.querySelectorAll(`.active-line`)?.forEach(el => el.classList.remove('active-line'));
    const previewBlock = this.view.previewArea
      .querySelector(`[data-id="${currentIndex}"]`) as HTMLElement;

    const editorBlock = this.view.editorPreviewContainer
      .querySelector(`[data-id='${currentIndex}']`) as HTMLElement;
    
    previewBlock.classList.add('active-line')
    editorBlock.classList.add('active-line')
    const editorToTop = editorBlock.offsetTop - this.view.editorPreviewContainer.scrollTop;

    const targetScrollTop = previewBlock.offsetTop - editorToTop;

    this.view.previewArea.scrollTo({
        top: targetScrollTop,
        behavior: 'smooth'
    });
  }
}