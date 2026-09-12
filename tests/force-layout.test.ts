import test from 'node:test';
import assert from 'node:assert/strict';
import { stepForces, type ForceNode } from '../packages/workbench/force-layout.js';
const node = (id: string, x: number, y: number): ForceNode => ({ id, x, y, vx: 0, vy: 0, labelWidth: 100 });
test('force layout separates coincident nodes, attracts connected distant nodes and stays finite', () => {
  const coincident = [node('a', 0, 0), node('b', 0, 0)];
  for (let i = 0; i < 250; i++) stepForces(coincident, [], .6);
  assert.ok(Math.hypot(coincident[0]!.x - coincident[1]!.x, coincident[0]!.y - coincident[1]!.y) > 42);
  const connected = [node('a', -400, 0), node('b', 400, 0)];
  for (let i = 0; i < 250; i++) stepForces(connected, [{ source: 'a', target: 'b', score: .8 }], .6);
  assert.ok(Math.abs(connected[0]!.x - connected[1]!.x) < 250);
  const crowded = Array.from({ length: 41 }, (_, i) => node(String(i), 0, 0));
  for (let i = 0; i < 500; i++) stepForces(crowded, crowded.slice(1).map(n => ({ source: '0', target: n.id, score: .5 })), .6);
  for (const n of crowded) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y) && Math.abs(n.x) <= 430 && Math.abs(n.y) <= 255);
});
test('dragging pins only the dragged node while its linked neighbor responds', () => {
  const nodes = [node('a', 0, 0), node('b', 160, 0)];
  for (let i = 0; i < 80; i++) stepForces(nodes, [{ source: 'a', target: 'b', score: .8 }], .8, { id: 'a', point: { x: -200, y: -100 } });
  assert.equal(nodes[0]!.x, -200); assert.equal(nodes[0]!.y, -100);
  assert.ok(nodes[1]!.x < 100 && nodes[1]!.y < 0);
});
