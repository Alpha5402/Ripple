export class EditorView {
  editorContainer: HTMLDivElement
  previewContainer: HTMLDivElement

  editorArea: HTMLTextAreaElement
  editorPlaceholder: HTMLDivElement
  editorPreviewContainer: HTMLDivElement
  previewArea: HTMLDivElement

  constructor(
    editorContainer: HTMLDivElement, 
    previewContainer: HTMLDivElement,
    initialContent: string
  ) {
    this.editorContainer = editorContainer;
    this.previewContainer = previewContainer;
    editorContainer.style.position = 'relative';
  
    this.editorPlaceholder = document.createElement('div');
    this.editorPlaceholder.className = 'md-editor-placeholder';
    editorContainer.appendChild(this.editorPlaceholder);
  
    this.editorArea = document.createElement('textarea');
    this.editorArea.className = 'md-editor-area';
    this.editorArea.value = initialContent;
    this.editorPlaceholder.appendChild(this.editorArea);
    this.editorPreviewContainer = document.createElement('div');
    this.editorPreviewContainer.className = 'md-preview-editor-area';
    this.editorPlaceholder.appendChild(this.editorPreviewContainer);
  
    this.previewArea = document.createElement('div');
    this.previewArea.className = 'md-preview-area';
    previewContainer.appendChild(this.previewArea);
  }

  destroy() {
    if (this.editorContainer.contains(this.editorPlaceholder)) {
      this.editorContainer.removeChild(this.editorPlaceholder);
    }
    if (this.previewContainer.contains(this.previewArea)) {
      this.previewContainer.removeChild(this.previewArea);
    }
  }

  getValue() {
    return this.editorArea.value
  }

  syncScroll() {
    this.editorPreviewContainer.scrollTop = this.editorArea.scrollTop
  }
}
