import { RenderView } from './RenderView'
import { DocumentController } from '../utils/DocumentController';
import { createBlockElement } from '../Editor/patch'
import { RendererController } from './RenderController'
import { parseLine } from '../parser';

export class Renderer {
  view: RenderView;
  doc: DocumentController;
  private onChange?: (content: string) => void;
  constructor(
    previewContainer: HTMLDivElement,
    documentTitle: string = '未命名',
    initialContent: string = ''
  ) {
    this.view = new RenderView(previewContainer, documentTitle)

    this.doc = new DocumentController()

    const blocks = this.doc
      .update(initialContent)
      .map(parseLine)

    blocks.forEach(block => {
      const el = createBlockElement(block, true)
      this.view.rendererArea.appendChild(el)
    })

    RendererController(this)
  }

  destroy() {
    this.view.destroy()
  }

  private updateRenderContent(content: string) {

  }
}