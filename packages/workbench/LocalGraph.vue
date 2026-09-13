<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount, onMounted } from 'vue';
import { forceSimulation, forceManyBody, forceLink, forceCollide, forceX, forceY, type Simulation } from 'd3-force';
import type { GlobalGraph, WorkbenchState } from '../host/contract.js';
import { stepForces, type ForceNode } from './force-layout.js';
const props = defineProps<{ state: WorkbenchState; selected?: string; globalGraph?: GlobalGraph; savedView?: { layout?: Record<string, { x: number; y: number }>; camera?: { x: number; y: number; zoom: number } } }>();
const emit = defineEmits<{ preview: [id: string]; focus: [id: string]; evidence: [id: string]; view: [view: { layout?: Record<string, { x: number; y: number }>; camera?: { x: number; y: number; zoom: number } }] }>();
const canvas = ref<SVGSVGElement>();
const camera = ref({ x: 0, y: 0, zoom: 1 });
const layout = ref<Record<string, { x: number; y: number }>>({});
const hoveredEdge = ref<string>(), hoveredNode = ref<string>();
const names = computed(() => new Map(props.state.documents.map(doc => [doc.id, doc.title])));
const focusId = computed(() => props.globalGraph ? '' : props.state.current?.snapshot.focusNode ?? '');
const relations = computed(() => props.globalGraph?.relations ?? props.state.visible?.graphRelations ?? props.state.visible?.relations ?? []);
const nodes = computed(() => props.globalGraph ? props.globalGraph.documents.map(d => d.id) : [...new Set([focusId.value, ...relations.value.flatMap(r => r.nodes)].filter(Boolean))]);
const links = computed(() => relations.value.map(r => ({ source: r.nodes[0], target: r.nodes[1], score: r.score })));
const pos = (id: string) => layout.value[id] ?? { x: 0, y: 0 };
const trim = (name: string) => Array.from(name).length > 18 ? Array.from(name).slice(0, 17).join('') + '…' : name;
let particles: ForceNode[] = [], frame = 0, alpha = 0, tick = 0, reducedMotion = false, lastFocus = '';
let simulation: Simulation<ForceNode, undefined> | undefined;
let lastTap: { id: string; at: number } | undefined;
let drag: { id?: string; x: number; y: number; startX: number; startY: number; moved: boolean; pointer: number } | undefined;
function publish() { const next = { ...layout.value }; for (const node of particles) next[node.id] = { x: node.x, y: node.y }; layout.value = next; }
function saveView() { emit('view', { layout: { ...layout.value }, camera: { ...camera.value } }); }
function step() {
  frame = 0;
  const pinned = drag?.id ? { id: drag.id, point: pos(drag.id) } : undefined;
  let energy = 1;
  if (simulation) { simulation.alpha(alpha).tick(); if (pinned) { const node = particles.find(n => n.id === pinned.id); if (node) Object.assign(node, pinned.point, { vx: 0, vy: 0 }); } }
  else energy = stepForces(particles, links.value, alpha, pinned);
  publish(); tick++; alpha *= .986;
  if ((alpha > .02 && (energy > .001 || tick < 45)) || drag?.id) frame = requestAnimationFrame(step);
  else saveView();
}
function restart() {
  cancelAnimationFrame(frame); alpha = .9; tick = 0;
  if (reducedMotion) { for (let i = 0; i < 200; i++) { if (simulation) simulation.alpha(.5 * (1 - i / 200)).tick(); else stepForces(particles, links.value, .5); } publish(); saveView(); frame = 0; }
  else frame = requestAnimationFrame(step);
}
watch(() => `${props.globalGraph ? nodes.value.join() : focusId.value}|${relations.value.map(r => `${r.id}:${r.score}`).join('|')}`, () => {
  if (lastFocus !== (props.globalGraph ? "global" : focusId.value)) {
    lastFocus = props.globalGraph ? "global" : focusId.value; camera.value = { ...((props.globalGraph ? props.savedView?.camera : props.state.current?.camera) ?? { x: 0, y: 0, zoom: 1 }) }; layout.value = { ...(props.globalGraph ? props.savedView?.layout : props.state.current?.layout) }; particles = []; drag = undefined;
  }
  const previous = new Map(particles.map(node => [node.id, node]));
  const radius = props.globalGraph ? Math.max(180, Math.sqrt(nodes.value.length) * 42) : 180;
  particles = nodes.value.map((id, index) => previous.get(id) ?? { id, ...(layout.value[id] ?? { x: Math.cos(index * 2.4) * (props.globalGraph ? Math.sqrt((index + 1) / nodes.value.length) : 1) * radius, y: Math.sin(index * 2.4) * (props.globalGraph ? Math.sqrt((index + 1) / nodes.value.length) : 1) * radius }), vx: 0, vy: 0, labelWidth: Math.min(145, Array.from(names.value.get(id) ?? '').length * 7) });
  simulation?.stop(); simulation = undefined;
  if (props.globalGraph) {
    simulation = forceSimulation(particles).stop()
      .force('charge', forceManyBody<ForceNode>().strength(-160))
      .force('links', forceLink<ForceNode, { source: string; target: string; score: number }>(links.value.map(l => ({ ...l }))).id(n => n.id).distance(l => 150 - l.score * 50).strength(.12))
      .force('collision', forceCollide<ForceNode>().radius(n => Math.max(24, n.labelWidth / 2 + 8)).strength(.65))
      .force('x', forceX(0).strength(.018)).force('y', forceY(0).strength(.018));
    if (!props.savedView?.camera && !previous.size) camera.value = { x: 0, y: 0, zoom: Math.max(.05, Math.min(1, 230 / radius)) };
  }
  hoveredEdge.value = undefined; hoveredNode.value = undefined;
  restart();
}, { immediate: true });
onMounted(() => { reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches; if (reducedMotion) restart(); });
onBeforeUnmount(() => { cancelAnimationFrame(frame); simulation?.stop(); });
function coordinates(event: PointerEvent) { const matrix = canvas.value!.getScreenCTM(); return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : { x: event.clientX, y: event.clientY }; }
function down(event: PointerEvent, id?: string) {
  if (event.button !== 0) return;
  event.stopPropagation(); const p = coordinates(event); const start = id ? pos(id) : camera.value;
  drag = { ...(id ? { id } : {}), x: p.x, y: p.y, startX: start.x, startY: start.y, moved: false, pointer: event.pointerId }; canvas.value!.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!drag) return; const p = coordinates(event); const dx = p.x - drag.x, dy = p.y - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.id && drag.moved) {
    layout.value[drag.id] = { x: drag.startX + dx / camera.value.zoom, y: drag.startY + dy / camera.value.zoom };
    const node = particles.find(node => node.id === drag!.id); if (node) Object.assign(node, pos(drag.id), { vx: 0, vy: 0 });
    if (!reducedMotion) { alpha = .65; if (!frame) frame = requestAnimationFrame(step); }
  } else if (!drag.id) camera.value = { ...camera.value, x: drag.startX + dx, y: drag.startY + dy };
}
function up(event: PointerEvent) {
  if (!drag) return;
  const previous = drag; drag = undefined;
  if (canvas.value?.hasPointerCapture(previous.pointer)) canvas.value.releasePointerCapture(previous.pointer);
  if (previous.moved) { lastTap = undefined; saveView(); if (previous.id) restart(); }
  else if (previous.id && event.type !== 'pointercancel') {
    // Pointer capture retargets native dblclick to the SVG; recognize consecutive node taps here.
    if (lastTap?.id === previous.id && event.timeStamp - lastTap.at < 350) { lastTap = undefined; explore(previous.id); }
    else { lastTap = { id: previous.id, at: event.timeStamp }; emit('preview', previous.id); }
  } else lastTap = undefined;
}
function explore(id: string) { if (props.globalGraph || id !== focusId.value) { saveView(); emit('focus', id); } }
function zoom(delta: number) { camera.value.zoom = Math.max(props.globalGraph ? .05 : .2, Math.min(4, (props.globalGraph ? camera.value.zoom * Math.exp(delta) : camera.value.zoom + delta))); emit('view', { camera: { ...camera.value } }); }
function resetCamera() {
  if (props.globalGraph && particles.length) {
    const xs = particles.map(n => n.x), ys = particles.map(n => n.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const zoom = Math.max(.05, Math.min(2, 850 / (maxX - minX + 180), 480 / (maxY - minY + 100)));
    camera.value = { x: -(minX + maxX) / 2 * zoom, y: -(minY + maxY) / 2 * zoom, zoom };
  } else camera.value = { x: 0, y: 0, zoom: 1 };
  saveView();
}
</script>
<template>
  <div class="graph-surface force-graph">
    <header class="graph-header"><div class="graph-caption"><span class="eyebrow">{{ globalGraph ? 'KNOWLEDGE NETWORK' : 'LOCAL EXPLORATION' }}</span><h2>{{ globalGraph ? '全局知识网络' : '从这里，发现关联。' }}</h2><p>拖动节点 · 点击预览 · 双击探索</p></div><slot name="controls"/></header>
    <div class="graph-viewport">
    <svg ref="canvas" class="local-graph" viewBox="0 0 1000 720" :aria-label="globalGraph ? '全局知识网络' : '当前笔记的局部知识图'" @pointerdown="down($event)" @pointermove="move" @pointerup="up" @pointercancel="up" @wheel.prevent="zoom($event.deltaY > 0 ? -.12 : .12)">
      <g :transform="`translate(${500 + camera.x} ${365 + camera.y}) scale(${camera.zoom})`">
        <g v-for="relation in relations" :key="relation.id" class="graph-edge" :class="{ selected: relation.id === selected, 'edge-active': hoveredEdge === relation.id || (hoveredNode && relation.nodes.includes(hoveredNode)) }" role="button" tabindex="0" :aria-label="`查看 ${relation.nodes.map(id => names.get(id)).join(' 与 ')} 的关系证据，权重 ${Math.round(relation.score * 100)}`" @pointerenter="hoveredEdge = relation.id" @pointerleave="hoveredEdge = undefined" @focus="hoveredEdge = relation.id" @blur="hoveredEdge = undefined" @pointerdown.stop @click.stop="emit('evidence', relation.id)" @keydown.enter="emit('evidence', relation.id)" @keydown.space.prevent="emit('evidence', relation.id)">
          <line class="edge-stroke" :x1="pos(relation.nodes[0]).x" :y1="pos(relation.nodes[0]).y" :x2="pos(relation.nodes[1]).x" :y2="pos(relation.nodes[1]).y" :style="{ opacity: .25 + relation.score * .4 }"/>
          <line class="edge-hit" :x1="pos(relation.nodes[0]).x" :y1="pos(relation.nodes[0]).y" :x2="pos(relation.nodes[1]).x" :y2="pos(relation.nodes[1]).y"/>
          <text class="edge-weight" text-anchor="middle" :x="(pos(relation.nodes[0]).x + pos(relation.nodes[1]).x) / 2" :y="(pos(relation.nodes[0]).y + pos(relation.nodes[1]).y) / 2 - 9">{{ Math.round(relation.score * 100) }}</text>
        </g>
        <g v-for="id in nodes" :key="id" class="graph-node" :class="{ center: id === focusId, visited: state.current?.visited.includes(id) }" :transform="`translate(${pos(id).x} ${pos(id).y})`" role="button" tabindex="0" :aria-label="`${id === focusId ? '当前中心' : '预览'}：${names.get(id)}`" @pointerenter="hoveredNode = id" @pointerleave="hoveredNode = undefined" @pointerdown="down($event, id)" @keydown.enter="emit('preview', id)" @keydown.space.prevent="explore(id)">
          <circle class="node-hit" :r="globalGraph ? Math.max(18, 10 / camera.zoom) : 18"/><circle class="node-dot" :r="globalGraph ? (id === focusId ? 4.5 : 3) / camera.zoom : id === focusId ? 7 : 4.5"/>
          <text class="node-label" text-anchor="middle" :y="globalGraph ? Math.max(25, 15 / camera.zoom) : 25" :style="globalGraph ? { fontSize: `${Math.max(12, 9 / camera.zoom)}px` } : undefined">{{ trim(names.get(id) ?? '') }}</text><title>{{ names.get(id) }}</title>
        </g>
      </g>
    </svg>
    <div class="graph-controls"><button aria-label="缩小图谱" @click="zoom(-.15)">−</button><span>{{ Math.round(camera.zoom * 100) }}%</span><button aria-label="放大图谱" @click="zoom(.15)">+</button><button @click="resetCamera">复位</button></div>
    <div class="graph-legend"><template v-if="!globalGraph"><span class="legend-dot"/> 当前笔记 </template><span class="legend-dot neighbor"/> {{ globalGraph ? '知识笔记' : '关联笔记' }} <span class="legend-line"/> 悬停查看权重</div>
    </div>
  </div>
</template>
<style>
.force-graph.graph-surface{background:var(--canvas,#f8f9fc);display:flex;flex-direction:column}.graph-header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:30px;padding:25px 30px 22px;flex-shrink:0}.graph-header .graph-caption{position:static;pointer-events:auto;min-width:180px}.graph-header .graph-caption h2{font-size:20px;margin:8px 0 6px}.graph-header .graph-caption p{margin:0;color:var(--secondary,#7b8ca7)}.graph-viewport{position:relative;min-height:0;flex:1;overflow:hidden}.graph-viewport .local-graph{display:block}@media(max-width:850px){.graph-header{padding:20px;gap:20px;flex-wrap:wrap}.graph-header .graph-lens{flex:1;max-width:none;min-width:220px}.graph-header .graph-caption h2{font-size:18px}}
.force-graph .graph-node{cursor:grab;filter:none}.force-graph .graph-node:active{cursor:grabbing}
.force-graph .graph-node>.node-hit{fill:transparent;stroke:none;filter:none}
.force-graph .graph-node>.node-dot{fill:#8796b0;stroke:none;filter:none;transition:fill .15s}
.force-graph .graph-node.center>.node-dot{fill:#587dd0}.force-graph .graph-node:hover>.node-dot,.force-graph .graph-node:focus>.node-dot{fill:#416dcc}
.force-graph .graph-node .node-label{font-size:12px;font-weight:400;fill:var(--secondary,#65738a);pointer-events:auto}.force-graph .graph-node.center .node-label{font-size:12px;font-weight:550;fill:var(--ink,#243657)}
.force-graph .graph-edge{cursor:pointer}.force-graph .graph-edge>.edge-stroke{stroke:#9aaac3;stroke-width:1;vector-effect:non-scaling-stroke}
.force-graph .graph-edge>.edge-hit{stroke:transparent;stroke-width:16;pointer-events:stroke;vector-effect:non-scaling-stroke}
.force-graph .graph-edge .edge-weight{opacity:0;fill:var(--secondary,#65738a);font-size:11px;pointer-events:none;transition:opacity .12s}
.force-graph .graph-edge:hover .edge-weight,.force-graph .graph-edge:focus .edge-weight{opacity:1}
.force-graph .graph-edge:focus-visible{outline:none}.force-graph .graph-edge:focus-visible>.edge-stroke{stroke:#416dcc;stroke-width:2.5}
.force-graph .graph-edge.edge-active>.edge-stroke{stroke:#587dd0;stroke-width:1.6}
@media(prefers-reduced-motion:reduce){.force-graph *{animation:none!important;transition:none!important}}
</style>
