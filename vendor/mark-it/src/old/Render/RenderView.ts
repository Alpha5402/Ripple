export class RenderView {
  rendererContainer: HTMLDivElement
  documentContainer: HTMLDivElement
  documentTitle: HTMLDivElement
  rendererArea: HTMLDivElement
  constructor(
    rendererContainer: HTMLDivElement, 
    documentTitle: string = ''

  ) {
    this.rendererContainer = rendererContainer;

    this.documentContainer = document.createElement('div');
    this.documentContainer.className = 'md-document';
    rendererContainer.appendChild(this.documentContainer);

    this.documentTitle = document.createElement('div');
    this.documentTitle.className = 'md-line-block md-heading-1'
    this.documentTitle.innerText = documentTitle
    this.documentContainer.appendChild(this.documentTitle)
    this.documentContainer.appendChild(document.createElement('hr'))
    
    this.rendererArea = document.createElement('div');
    this.rendererArea.className = 'md-renderer-area';
    this.documentContainer.appendChild(this.rendererArea);
  }

  destroy() {
    if (this.rendererContainer.contains(this.rendererArea)) {
      this.rendererContainer.removeChild(this.rendererArea);
    }
  }
}
