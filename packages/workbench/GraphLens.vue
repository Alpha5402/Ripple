<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ value: number; global?: boolean; count: number; documents?: number }>();
const emit = defineEmits<{ change: [value: number] }>();
const scope = computed(() => props.global ? '筛选全局关联，保留全部笔记' : '在当前有效邻域内探索');
</script>
<template>
  <section class="graph-lens" :aria-label="global ? '全局图谱范围' : '局部探索范围'">
    <div class="graph-lens-heading"><label :for="global ? 'global-graph-lens' : 'local-graph-lens'" :title="scope">Knowledge Lens</label><span>{{ global ? `${documents ?? 0} 篇笔记 · ` : '' }}{{ count }} 条关联</span></div>
    <input :id="global ? 'global-graph-lens' : 'local-graph-lens'" type="range" min="0" max="100" step="1" :value="value" :style="{ '--range-progress': `${value}%` }" :aria-label="global ? '全局 Knowledge Lens' : 'Knowledge Lens，从聚焦到拓展'" :aria-valuetext="`${scope}，拓展程度 ${value}%`" @input="emit('change', Number(($event.target as HTMLInputElement).value))"/>
    <div class="graph-lens-labels" aria-hidden="true"><span>Focus · 聚焦</span><span>Explore · 拓展</span></div>
  </section>
</template>
<style>
.graph-lens{flex:0 1 310px;min-width:230px;max-width:380px}.graph-lens-heading{display:flex;align-items:baseline;justify-content:space-between;gap:16px;font-size:11px;color:var(--secondary,#64748b)}.graph-lens-heading label{font-weight:600;color:var(--ink,#34496c);white-space:nowrap}.graph-lens-heading>span{font-size:10px;font-variant-numeric:tabular-nums;white-space:nowrap}.graph-lens input{display:block;width:100%;height:30px;margin:2px 0 0;padding:0;appearance:none;background:transparent;cursor:pointer;border:0}.graph-lens input::-webkit-slider-runnable-track{height:4px;border-radius:4px;background:linear-gradient(to right,var(--accent,#6d90cc) var(--range-progress),var(--line,#e4e9f2) var(--range-progress))}.graph-lens input::-webkit-slider-thumb{appearance:none;margin-top:-5px;width:14px;height:14px;border-radius:50%;border:1px solid var(--accent,#6d90cc);background:var(--surface,#fff);box-shadow:0 1px 4px #314d8220}.graph-lens input::-moz-range-track{height:4px;border-radius:4px;background:var(--line,#e4e9f2)}.graph-lens input::-moz-range-progress{height:4px;background:var(--accent,#6d90cc)}.graph-lens input::-moz-range-thumb{width:13px;height:13px;border-radius:50%;border:1px solid var(--accent,#6d90cc);background:var(--surface,#fff)}.graph-lens input:focus-visible{outline:2px solid var(--accent,#6d90cc);outline-offset:3px;border-radius:5px}.graph-lens-labels{display:flex;justify-content:space-between;font-size:10px;color:var(--secondary,#64748b)}
</style>
