import { MarkdownEditor } from "./MarkdownEditor"

export const EditorController = (editor: MarkdownEditor) => {
  const area = editor.view.editorArea

  area.addEventListener('input', () => editor.handleInput())
  area.addEventListener('scroll', () => editor.handleScroll())
  area.addEventListener('keyup', () => editor.handleCursorChange())
  area.addEventListener('mouseup', () => editor.handleCursorChange())
}
