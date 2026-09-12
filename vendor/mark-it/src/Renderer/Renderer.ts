import { DocumentController } from '../utils/DocumentController';
import { DOMController } from '../utils/DOMController';
import { RenderView } from './RendererView';
import type { HTMLPolicy } from '../types';

export interface RendererOptions {
  htmlPolicy?: HTMLPolicy
}

export class Renderer {
  view: RenderView;
  doc: DocumentController
  dom: DOMController;
  private onChange?: (content: string) => void;
  constructor(
    previewContainer: HTMLDivElement,
    documentTitle: string = '未命名',
    initialContent: string = '',
    options: RendererOptions = {}
  ) {
    this.view = new RenderView(previewContainer, documentTitle)

    this.doc = new DocumentController(initialContent)

    const blocks = Array.from(this.doc.getBlocks().values())
    this.dom = new DOMController(
      this.view.area,
      blocks,
      id => this.doc.getRawText(id),
      options.htmlPolicy ?? 'sanitize'
    )
  }

  destroy() {
    this.view.destroy()
  }
}
