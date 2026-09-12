<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkbenchState } from '../host/contract.js';
const props = defineProps<{ state: WorkbenchState; selected?: string }>();
const emit = defineEmits<{ preview: [id: string]; focus: [id: string]; evidence: [id: string]; view: [view: { layout?: Record<string, { x: number; y: number }>; camera?: { x: number; y: number; zoom: number } }] }>();
const canvas = ref<SVGSVGElement>();
const camera = ref({ x: 0, y: 0, zoom: 1 });
const layout = ref<Record<string, { x: number; y: number }>>({});
watch(() => props.state.current, current => { if (current) { camera.value = { ...current.camera }; layout.value = { ...current.layout }; } }, { immediate: true });
const names = computed(() => new Map(props.state.documents.map(doc => [doc.id, doc.title])));
const focusId = computed(() => props.state.current?.snapshot.focusNode ?? '');
const relations = computed(() => props.state.visible?.relations ?? []);
const nodes = computed(() => [...new Set([focusId.value, ...relations.value.flatMap(r => r.nodes)].filter(Boolean))]);
const pos = (id: string) => layout.value[id] ?? { x: 0, y: 0 };
const trim = (name: string) => Array.from(name).length > 16 ? Array.from(name).slice(0, 15).join('') + '…' : name;
let drag: { id?: string; x: number; y: number; startX: number; startY: number; moved: boolean } | undefined;
function coordinates(event: PointerEvent) { const matrix = canvas.value!.getScreenCTM(); return matrix ? new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse()) : { x: event.clientX, y: event.clientY }; }
function down(event: PointerEvent, id?: string) {
  if (event.button !== 0) return;
  event.stopPropagation(); const p = coordinates(event); const start = id ? pos(id) : camera.value;
  drag = { ...(id ? { id } : {}), x: p.x, y: p.y, startX: start.x, startY: start.y, moved: false }; canvas.value!.setPointerCapture(event.pointerId);
}
function move(event: PointerEvent) {
  if (!drag) return; const p = coordinates(event); const dx = p.x - drag.x, dy = p.y - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.id) layout.value[drag.id] = { x: drag.startX + dx / camera.value.zoom, y: drag.startY + dy / camera.value.zoom };
  else camera.value = { ...camera.value, x: drag.startX + dx, y: drag.startY + dy };
}
function up() {
  if (!drag) return;
  if (drag.moved) emit('view', { layout: layout.value, camera: camera.value });
  else if (drag.id) emit('preview', drag.id);
  drag = undefined;
}
function zoom(delta: number) { camera.value.zoom = Math.max(0.2, Math.min(4, camera.value.zoom + delta)); emit('view', { camera: camera.value }); }
</script>
<template>
  <div class="graph-surface">
    <div class="graph-caption"><span class="eyebrow">LOCAL EXPLORATION</span><h2>从这里，发现关联。</h2><p>点击预览 · 双击继续探索</p></div>
    <svg ref="canvas" class="local-graph" viewBox="0 0 1000 720" aria-label="当前笔记的局部知识图" @pointerdown="down($event)" @pointermove="move" @pointerup="up" @pointercancel="up">
      <defs><radialGradient id="focus-halo"><stop offset="0" stop-color="#668ee9" stop-opacity=".13"/><stop offset="1" stop-color="#668ee9" stop-opacity="0"/></radialGradient></defs>
      <g :transform="`translate(${500 + camera.x} ${365 + camera.y}) scale(${camera.zoom})`">
        <circle r="255" fill="url(#focus-halo)" pointer-events="none" />
        <circle class="orbit" r="195"/><circle class="orbit" r="355"/>
        <g v-for="relation in relations" :key="relation.id" class="graph-edge" :class="{ selected: relation.id === selected }">
          <line :x1="pos(relation.nodes[0]).x" :y1="pos(relation.nodes[0]).y" :x2="pos(relation.nodes[1]).x" :y2="pos(relation.nodes[1]).y" :style="{ opacity: .22 + relation.score * .55 }" />
          <g role="button" tabindex="0" :aria-label="`查看与 ${names.get(relation.nodes.find(id => id !== focusId)!)} 的关系证据`" :transform="`translate(${(pos(relation.nodes[0]).x + pos(relation.nodes[1]).x) / 2} ${(pos(relation.nodes[0]).y + pos(relation.nodes[1]).y) / 2})`" @pointerdown.stop @click.stop="emit('evidence', relation.id)" @keydown.enter="emit('evidence', relation.id)"><rect x="-18" y="-10" width="36" height="20" rx="10"/><text text-anchor="middle" dominant-baseline="middle">{{ Math.round(relation.score * 100) }}</text></g>
        </g>
        <g v-for="id in nodes" :key="id" class="graph-node" :class="{ center: id === focusId, visited: state.current?.visited.includes(id) }" :transform="`translate(${pos(id).x} ${pos(id).y})`" role="button" tabindex="0" :aria-label="`${id === focusId ? '当前中心' : '预览'}：${names.get(id)}`" @pointerdown="down($event, id)" @dblclick.stop="id !== focusId && emit('focus', id)" @keydown.enter="emit('preview', id)" @keydown.space.prevent="id !== focusId && emit('focus', id)">
          <circle :r="id === focusId ? 35 : 22"/><path v-if="id === focusId" d="M-8 0a8 8 0 0 1 16 0 M-13 0a13 13 0 0 1 26 0 M-4 3a4 4 0 0 1 8 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><text v-else text-anchor="middle" dominant-baseline="middle" y="1">{{ Array.from(names.get(id) ?? '?')[0] }}</text>
          <rect :x="id === focusId ? -100 : -87" :y="id === focusId ? 44 : 31" :width="id === focusId ? 200 : 174" height="28" rx="8" class="node-label-background"/><text class="node-label" text-anchor="middle" :y="id === focusId ? 62 : 49">{{ trim(names.get(id) ?? '') }}</text><title>{{ names.get(id) }}</title>
        </g>
      </g>
    </svg>
    <div class="graph-controls"><button aria-label="缩小图谱" @click="zoom(-.15)">−</button><span>{{ Math.round(camera.zoom * 100) }}%</span><button aria-label="放大图谱" @click="zoom(.15)">+</button><button @click="camera = { x: 0, y: 0, zoom: 1 }; emit('view', { camera })">复位</button></div>
    <div class="graph-legend"><span class="legend-dot"/> 当前中心 <span class="legend-dot neighbor"/> 可见关联 <span class="legend-line"/> 关系强度</div>
  </div>
</template>
