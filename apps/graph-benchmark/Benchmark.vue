<script setup lang="ts">
import { nextTick, ref, shallowRef } from 'vue';
import LocalGraph from '../../packages/workbench/LocalGraph.vue';
import type { WorkbenchState } from '../../packages/host/contract.js';
import type { Relation } from '../../packages/core/model.js';
const scene = ref('40'), running = ref(false), report = ref('');
const state = shallowRef<WorkbenchState>();
function fixture(count: number) {
  const edges = count === 1000 ? 5000 : 40;
  const layout: Record<string, { x: number; y: number }> = {};
  const documents = Array.from({ length: count === 1000 ? 1000 : 41 }, (_, i) => { layout['n' + i] = { x: Math.cos(i * 2.399) * Math.sqrt(i) * 20, y: Math.sin(i * 2.399) * Math.sqrt(i) * 20 }; return { id: 'n' + i, title: '知识 ' + i, path: i + '.md', revision: 1 }; });
  const relations = Array.from({ length: edges }, (_, i) => ({ id: 'r' + i, nodes: count === 1000 ? ['n' + (i % 1000), 'n' + ((i % 1000 + 1 + Math.floor(i / 1000)) % 1000)] : ['n0', 'n' + (i + 1)], score: .1 + (i % 100) / 111, signals: [], components: { mention: 0, explicit: 0, semantic: { status: 'not-configured' } }, override: {}, scoreVersion: 'renderer-fixture' } as Relation));
  // Synthetic renderer input only: this is deliberately not a kernel relation-quality benchmark.
  const input = { label: '图谱压力样本', mode: 'public', readOnly: true, documents, canBack: false, indexing: false, notices: [], current: { camera: { x: 0, y: 0, zoom: count === 1000 ? .45 : 1 }, layout, visited: ['n0'], snapshot: { focusNode: 'n0' } }, visible: { relations } } as unknown as WorkbenchState;
  return { input, relations };
}
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function prepare() { state.value = fixture(Number(scene.value)).input; }
async function run() {
  running.value = true; report.value = '';
  const samples: number[] = []; const { input, relations } = fixture(Number(scene.value));
  const started = performance.now(); state.value = input; await nextTick(); await frame(); const firstPaint = performance.now() - started;
  const original = new Map([...document.querySelectorAll('.graph-node')].map(el => [el.getAttribute('aria-label'), el.getAttribute('transform')]));
  let stableLayout = true;
  for (let i = 0; i < 50; i++) {
    const threshold = (i % 10) / 10; const start = performance.now();
    state.value = { ...input, visible: { ...input.visible!, relations: relations.filter(r => r.score >= threshold) } };
    await nextTick(); await frame(); samples.push(performance.now() - start);
    for (const el of document.querySelectorAll('.graph-node')) if (original.get(el.getAttribute('aria-label')) !== el.getAttribute('transform')) stableLayout = false;
  }
  state.value = input; await nextTick(); await frame();
  samples.sort((a,b)=>a-b);
  report.value = JSON.stringify({ scene: Number(scene.value), nodes: input.documents.length, edges: relations.length, samples: samples.length, firstPresentationMs: firstPaint, lensToPresentationP50Ms: samples[Math.floor(samples.length*.5)], lensToPresentationP95Ms: samples[Math.ceil(samples.length*.95)-1], stableLayout, includesTwoAnimationFrames: true, modelEncodingIncluded: false, userAgent: navigator.userAgent }, null, 2);
  running.value = false;
}
prepare();
</script>
<template><div class="benchmark"><header><h1>图谱渲染验收</h1><label>场景 <select v-model="scene" @change="prepare" :disabled="running"><option value="40">日常上限：41 节点 / 40 边</option><option value="1000">压力场景：1,000 节点 / 5,000 边</option></select></label><button :disabled="running" @click="run">{{ running ? '测量中…' : '运行 50 次 Lens 呈现测量' }}</button><p>合成数据，复用 LocalGraph；结果包括 Vue 更新及两次动画帧，不包含模型编码。</p></header><pre v-if="report" id="benchmark-result">{{ report }}</pre><LocalGraph v-if="state" :state="state"/></div></template>
<style>.benchmark{height:100dvh;display:flex;flex-direction:column}.benchmark header{padding:10px 20px;background:white}.benchmark h1{font-size:16px;margin:0 0 10px}.benchmark header button{margin-left:20px}.benchmark header p{font-size:11px;color:#6e7b8f}.benchmark>pre{position:absolute;z-index:5;right:20px;top:110px;font-size:11px;background:#ffffffec;padding:12px}.benchmark>.graph-surface{flex:1;min-height:0}</style>
