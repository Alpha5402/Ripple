import { parentPort, workerData } from 'node:worker_threads';
import { NodeWorkspace } from '../../packages/host/node-workspace.js';
import { serializeOperationError } from '../../packages/core/errors.js';

const port = parentPort!;
const host = await NodeWorkspace.open(workerData.root, { stateDir: workerData.stateDir, readOnly: workerData.readOnly, apiKey: workerData.apiKey, changed: () => port.postMessage({ event: 'changed' }) });
port.on('message', async ({ id, command, configure, close }) => {
  try {
    const result = close ? await host.close() : configure ? await host.configureEmbedding(configure) : await host.command(command);
    port.postMessage({ id, ok: true, result });
    if (close) port.close();
  } catch (error) { port.postMessage({ id, ok: false, error: serializeOperationError(error) }); }
});
port.postMessage({ event: 'ready' });
