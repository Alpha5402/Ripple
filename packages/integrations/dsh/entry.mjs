import { Service } from '@deepseek-ai/cordis';
import { NodeWorkspace } from '../../host/node-workspace.js';
import { HarnessKnowledge } from './knowledge.js';
import { registerKnowledgeTools } from './plugin.js';
import { startKnowledgePanel } from './http.js';

export const name = 'ripple-knowledge';
export const inject = ['tools', 'systemPrompt'];
export async function apply(ctx, config) {
  const workspace = await NodeWorkspace.open(config.vault, { stateDir: config.stateDir, readOnly: true });
  ctx.effect(() => () => workspace.close(), 'Ripple vault lifecycle');
  if (config.embedding) await workspace.configureEmbedding(config.embedding);
  const knowledge = new HarnessKnowledge(workspace.service);
  class RippleKnowledgeService extends Service {
    constructor() { super(ctx, 'rippleKnowledge'); this.knowledge = knowledge; }
  }
  new RippleKnowledgeService();
  ctx.effect(() => () => knowledge.close(), 'Ripple knowledge sessions');
  ctx.effect(() => registerKnowledgeTools(ctx, knowledge), 'Ripple native tools and context');
  if (config.panel) {
    const panel = await startKnowledgePanel(knowledge, config.panel);
    ctx.effect(() => () => panel.close(), 'Ripple panel server');
  }
}
