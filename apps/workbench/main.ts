import { createApp } from 'vue';
import Workbench from '../../packages/workbench/Workbench.vue';
import type { WorkbenchBridge } from '../../packages/host/contract.js';
import '../../packages/workbench/style.css';
declare global { interface Window { ripple?: WorkbenchBridge } }
const native = window.ripple;
const bridge = native ? { ...native, async command(command: Parameters<WorkbenchBridge['command']>[0]) {
  // Commands are JSON data; detach Vue proxies before crossing contextBridge.
  const response = await native.command(JSON.parse(JSON.stringify(command))) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
  if (!response.ok) throw Object.assign(new Error(response.error?.message ?? '目录服务不可用'), { code: response.error?.code });
  return response.result;
} } : undefined;
if (bridge) createApp(Workbench, { bridge }).mount('#app');
else if (new URLSearchParams(location.search).has('harness')) {
  const { default: HarnessApp } = await import('../../packages/workbench/HarnessApp.vue');
  createApp(HarnessApp, { sessionId: new URLSearchParams(location.search).get('harness')! }).mount('#app');
}
else {
  const { loadPublicBridge } = await import('../../packages/workbench/public-bridge.js');
  try { createApp(Workbench, { bridge: await loadPublicBridge() }).mount('#app'); }
  catch (error) { const root = document.querySelector('#app')!; root.textContent = (error as Error).message; root.setAttribute('role', 'alert'); }
}
