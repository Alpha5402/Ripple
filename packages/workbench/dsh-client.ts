import { createApp, h, shallowRef } from 'vue';
import DshPanel from './DshPanel.vue';
import portalCss from './dsh-panel.css?inline';
export const inject = ['sessions'];
/** An owned Vue portal; no React component or runtime is imported by Ripple. */
export function apply(ctx: { sessions: { list: { getSnapshot(): { current?: string }; subscribe(listener: () => void): () => void } }; effect(install: () => () => void, label: string): void }, config: { endpoint?: string } = {}) {
  const endpoint = new URL(config.endpoint ?? 'http://127.0.0.1:47321');
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) throw new Error('Ripple panel endpoint must be a local IPv4 HTTP origin');
  ctx.effect(() => {
    const style = document.createElement('style'); style.textContent = portalCss; document.head.append(style);
    const root = document.createElement('div'); root.dataset.rippleDshPortal = 'true'; document.body.append(root);
    const session = shallowRef(ctx.sessions.list.getSnapshot().current);
    const unsubscribe = ctx.sessions.list.subscribe(() => { session.value = ctx.sessions.list.getSnapshot().current; });
    const app = createApp({ render: () => h(DshPanel, { endpoint: endpoint.origin, ...(session.value ? { sessionId: session.value } : {}) }) }); app.mount(root);
    return () => { unsubscribe(); app.unmount(); root.remove(); style.remove(); };
  }, 'Ripple Vue knowledge portal');
}
