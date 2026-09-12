<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import Workbench from './Workbench.vue';
import { createHarnessBridge } from './harness-bridge.js';
import type { HarnessState } from '../integrations/dsh/knowledge.js';
const props = defineProps<{ sessionId: string }>();
const host = createHarnessBridge(props.sessionId), state = ref<HarnessState>(), error = ref('');
let unsubscribe = () => {};
const refresh = async () => { try { state.value = await host.state(); } catch (e) { error.value = (e as Error).message; } };
async function follow(event: Event) { try { await host.follow((event.target as HTMLInputElement).checked); error.value = ''; } catch (e) { error.value = (e as Error).message; } }
async function decide(id: string, approve: boolean) { try { await host.decision(id, approve); error.value = ''; } catch (e) { error.value = (e as Error).message; } }
onMounted(() => { void refresh(); unsubscribe = host.bridge.subscribe(() => { void refresh(); }); });
onBeforeUnmount(() => unsubscribe());
</script>
<template><div class="harness-shell"><header class="harness-bar"><strong>Knowledge Workspace</strong><label><input type="checkbox" :checked="state?.harness.followLens" @change="follow"/>Follow Lens</label><span>{{ state?.harness.followLens ? '当前可见证据将在下次请求时进入 Agent 上下文' : '开启后，让 Agent 跟随你的可见知识范围' }}</span></header><div v-if="error" class="error-banner" role="alert">{{ error }}</div><section v-if="state?.harness.proposals.length" class="harness-proposals" aria-label="Agent 提议探索的知识"><strong>Agent 建议进一步探索</strong><div v-for="p in state.harness.proposals" :key="p.id"><span><b>{{ p.title }}</b> · {{ Math.round(p.score * 100) }}<small>{{ p.reason }}</small></span><button @click="decide(p.id, false)">暂不展开</button><button class="primary-button" @click="decide(p.id, true)">扩展可见范围</button></div><small>确认前，Agent 不会获得这些候选的原文证据。</small></section><Workbench :bridge="host.bridge"/></div></template>
<style>
.harness-shell{height:100dvh;display:flex;flex-direction:column}.harness-shell>.workbench{height:auto;flex:1;min-height:0}.harness-bar{display:flex;align-items:center;gap:20px;padding:12px 20px;background:#fff;border-bottom:1px solid #e4e7ec;font:13px -apple-system,BlinkMacSystemFont,sans-serif}.harness-bar label{display:flex;gap:7px;align-items:center;white-space:nowrap}.harness-bar>span{font-size:11px;color:#697586}.harness-proposals{padding:12px 20px;background:#f1f6ff;font-size:12px}.harness-proposals>div{display:flex;align-items:center;gap:12px;padding:8px 0}.harness-proposals span{flex:1}.harness-proposals small{display:block;color:#697586;margin-top:4px}@media(max-width:700px){.harness-bar>span{display:none}}
</style>
