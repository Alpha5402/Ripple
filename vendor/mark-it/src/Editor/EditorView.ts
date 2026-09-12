import type { DocumentMetadata } from '../types'

export class EditorView {
  container: HTMLDivElement
  document: HTMLDivElement
  title: HTMLDivElement
  metadata: HTMLDivElement | null = null
  area: HTMLDivElement
  constructor(
    rendererContainer: HTMLDivElement, 
    title: string = '',
    metadata?: DocumentMetadata
  ) {
    this.container = rendererContainer;

    this.document = document.createElement('div');
    this.document.className = 'md-document';
    rendererContainer.appendChild(this.document);

    this.title = document.createElement('div');
    this.title.className = 'md-line-block md-heading-1'
    this.title.contentEditable = 'true'
    this.title.innerText = title
    this.document.appendChild(this.title)

    // 渲染元数据区域（作者、更新时间等）
    if (metadata && metadata.items.length > 0) {
      this.metadata = document.createElement('div')
      this.metadata.className = 'md-metadata'
      this.metadata.contentEditable = 'false'
      for (const item of metadata.items) {
        const span = document.createElement('span')
        span.className = 'md-metadata-item'
        const label = document.createElement('span')
        label.className = 'md-metadata-label'
        label.textContent = item.label
        const value = document.createElement('span')
        value.className = 'md-metadata-value'
        value.textContent = item.value
        span.append(label, value)
        this.metadata.appendChild(span)
      }
      this.document.appendChild(this.metadata)
    }

    this.document.appendChild(document.createElement('hr'))
    
    this.area = document.createElement('div');
    this.area.className = 'md-renderer-area';
    this.area.contentEditable = 'true';
    this.document.appendChild(this.area);
  }

  destroy() {
    if (this.container.contains(this.document)) {
      this.container.removeChild(this.document);
    }
  }

  extractText(blockEl: HTMLDivElement): string {
    const currentBlock = blockEl.closest('.md-line-block') as HTMLDivElement
    if (!currentBlock) return ''

    // 展开模式下，结构性标记符是文本节点，直接拼接所有文本
    // 检查是否有 md-struct-marker 元素（展开模式的标志）
    const structMarkers = currentBlock.querySelectorAll('.md-struct-marker')
    if (structMarkers.length > 0) {
      // 展开模式：拼接结构性标记符文本 + inline 内容文本（排除 inline 标记符）
      let text = ''
      for (const marker of structMarkers) {
        text += marker.textContent ?? ''
      }
      const inlineContent = currentBlock.querySelector('.md-inline-content')
      if (inlineContent) {
        // 遍历 inline-content 中的文本节点，排除 .md-marker 内的文本
        const walker = document.createTreeWalker(
          inlineContent,
          NodeFilter.SHOW_TEXT,
          null
        )
        let textNode: Text | null
        while ((textNode = walker.nextNode() as Text)) {
          // 检查是否在 .md-marker 内
          let inMarker = false
          let el = textNode.parentElement
          while (el) {
            if (el.classList.contains('md-marker')) { inMarker = true; break }
            if (el.classList.contains('md-inline-content')) break
            el = el.parentElement
          }
          if (!inMarker) {
            text += textNode.textContent ?? ''
          }
        }
      }
      return text
    }

    if (!currentBlock.lastElementChild) 
      return ''

    const classList = currentBlock.lastElementChild.classList

    if (classList.contains('md-paragraph')) {
      // 直接拼 inline 文本
      return Array.from(blockEl.childNodes)
        .map(node => node.textContent ?? '')
        .join('')
    }

    if (classList.contains('md-list-item')) {
      // 列表 marker + 内容
      const markerEl = blockEl.querySelector('.md-list-marker')
      const contentEl = blockEl.querySelector('div') // 包裹实际文本的 div

      const markerText = markerEl?.textContent ?? ''
      const contentText = contentEl?.textContent ?? ''
      return markerText + ' ' + contentText
    }

    if (classList.contains('md-heading')) {
      // heading token + 内容
      const tokenEl = blockEl.querySelector('.md-heading-token')
      const contentText = Array.from(blockEl.childNodes)
        .filter(n => n !== tokenEl)
        .map(n => n.textContent ?? '')
        .join('')
      return (tokenEl?.textContent ?? '') + ' ' + contentText
    }

    // fallback
    return blockEl.textContent ?? ''
  }


}
