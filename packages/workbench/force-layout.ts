export interface ForceNode { id: string; x: number; y: number; vx: number; vy: number; labelWidth: number }
export interface ForceLink { source: string; target: string; score: number }
export interface Point { x: number; y: number }

/** Bounded local graph physics. State stays separate from the semantic candidate set. */
export function stepForces(nodes: ForceNode[], links: ForceLink[], alpha: number, pinned?: { id: string; point: Point }): number {
  const forces = nodes.map(() => ({ x: 0, y: 0 }));
  const indexes = new Map(nodes.map((node, index) => [node.id, index]));
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i]!, b = nodes[j]!;
    let dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) + Math.abs(dy) < .01) { dx = Math.cos(i * 2.4 + j) * .5; dy = Math.sin(i * 2.4 + j) * .5; }
    const distance = Math.max(12, Math.hypot(dx, dy));
    const repel = 1900 / (distance * distance);
    const fx = dx / distance * repel, fy = dy / distance * repel;
    forces[i]!.x -= fx; forces[i]!.y -= fy; forces[j]!.x += fx; forces[j]!.y += fy;
    // Labels sit beneath each dot. Keep their rectangular footprints apart too.
    const width = (a.labelWidth + b.labelWidth) / 2 + 16, height = 42;
    if (Math.abs(dx) < width && Math.abs(dy) < height) {
      const overlapX = width - Math.abs(dx), overlapY = height - Math.abs(dy);
      if (overlapX < overlapY) { const force = Math.sign(dx || 1) * overlapX * .12; forces[i]!.x -= force; forces[j]!.x += force; }
      else { const force = Math.sign(dy || 1) * overlapY * .12; forces[i]!.y -= force; forces[j]!.y += force; }
    }
  }
  for (const link of links) {
    const i = indexes.get(link.source), j = indexes.get(link.target);
    if (i === undefined || j === undefined) continue;
    const a = nodes[i]!, b = nodes[j]!;
    const dx = b.x - a.x, dy = b.y - a.y, distance = Math.max(1, Math.hypot(dx, dy));
    const target = 205 - link.score * 55 + Math.max(0, nodes.length - 8) * 2;
    const force = (distance - target) * .022;
    forces[i]!.x += dx / distance * force; forces[i]!.y += dy / distance * force;
    forces[j]!.x -= dx / distance * force; forces[j]!.y -= dy / distance * force;
  }
  let energy = 0;
  nodes.forEach((node, i) => {
    if (node.id === pinned?.id) { node.x = pinned.point.x; node.y = pinned.point.y; node.vx = node.vy = 0; return; }
    node.vx = (node.vx + (forces[i]!.x - node.x * .0015) * alpha) * .82;
    node.vy = (node.vy + (forces[i]!.y - node.y * .0015) * alpha) * .82;
    node.x = Math.max(-430, Math.min(430, node.x + Math.max(-9, Math.min(9, node.vx))));
    node.y = Math.max(-255, Math.min(255, node.y + Math.max(-9, Math.min(9, node.vy))));
    energy += node.vx * node.vx + node.vy * node.vy;
  });
  return energy;
}
