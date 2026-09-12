import { Renderer } from "./Renderer"
import { enterEditMode } from './RenderEditor'

export const RendererController = (render: Renderer) => {
  const area = render.view.rendererArea

  area.addEventListener('click', (e) => {
    const block = (e.target as HTMLElement)
      .closest('.md-line-block') as HTMLElement | null;
    if (!block) return;
    if (block.classList.contains('md-editing')) return;

    enterEditMode(render, block);
  });
}
