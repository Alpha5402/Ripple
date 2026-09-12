export class RenderView {
  container: HTMLDivElement
  documentContainer: HTMLDivElement
  documentTitle: HTMLDivElement
  area: HTMLDivElement
  constructor(
    rendererContainer: HTMLDivElement, 
    documentTitle: string = ''

  ) {
    this.container = rendererContainer;

    this.documentContainer = document.createElement('div');
    this.documentContainer.className = 'md-document';
    rendererContainer.appendChild(this.documentContainer);

    this.documentTitle = document.createElement('div');
    this.documentTitle.className = 'md-line-block md-heading-1'
    this.documentTitle.innerText = documentTitle
    this.documentContainer.appendChild(this.documentTitle)
    this.documentContainer.appendChild(document.createElement('hr'))
    
    this.area = document.createElement('div');
    this.area.className = 'md-renderer-area';
    this.documentContainer.appendChild(this.area);
  }

  destroy() {
    if (this.container.contains(this.documentContainer)) {
      this.container.removeChild(this.documentContainer);
    }
  }
}