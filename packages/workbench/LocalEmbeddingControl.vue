<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import type { WorkbenchBridge } from '../host/contract.js';
import type { LocalEmbeddingState } from '../host/local-embedding.js';
const props = defineProps<{ bridge: WorkbenchBridge; disabled?: boolean }>();
const emit = defineEmits<{ ready: [baseUrl: string] }>();
const state = ref<LocalEmbeddingState>(), working = ref(false), error = ref('');
let timer: ReturnType<typeof setInterval> | undefined, alive = true, polling = false;
async function refresh() {
  if (polling) return; polling = true;
  try { const next = await props.bridge.localEmbeddingStatus?.(); if (alive && next) state.value = next; }
  catch { /* Keep a pending action's error; retry on the next poll. */ }
  finally { polling = false; }
}
async function start() {
  working.value = true; error.value = '';
  try { const next = await props.bridge.startLocalEmbedding?.(); if (next) { state.value = next; if (next.status === 'ready') emit('ready', next.baseUrl); } }
  catch (cause) { error.value = (cause as Error).message; }
  finally { working.value = false; await refresh(); }
}
async function stop() {
  working.value = true; error.value = '';
  try { state.value = await props.bridge.stopLocalEmbedding?.(); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { working.value = false; }
}
async function choose() {
  error.value = '';
  try { const next = await props.bridge.chooseLocalEmbeddingRuntime?.(); if (next) state.value = next; }
  catch (cause) { error.value = (cause as Error).message; }
}
async function autoStart(enabled: boolean) {
  try { state.value = await props.bridge.setLocalEmbeddingAutoStart?.(enabled); }
  catch (cause) { error.value = (cause as Error).message; }
}
onMounted(() => { void refresh(); timer = setInterval(() => { void refresh(); }, 1000); });
onBeforeUnmount(() => { alive = false; clearInterval(timer); });
</script>
<template>
  <section class="local-embedding-control" aria-label="本机 Embedding 服务">
    <div class="local-service-heading"><strong>本机 WeMM 服务</strong><span v-if="state" class="local-service-status" :class="{ ready: state.status === 'ready' }">{{ ({ unavailable:'需要运行环境', stopped:'未启动', starting:'正在加载', ready:'已就绪', stopping:'正在停止', error:'未就绪' })[state.status] }}</span></div>
    <p aria-live="polite">{{ state?.message ?? '正在检查服务…' }}</p>
    <div class="local-service-actions"><button type="button" class="primary-button" :disabled="disabled || working || !state || state.status === 'starting' || state.status === 'stopping' || (!state.runtimePath && state.status !== 'ready')" @click="start">{{ working || state?.status === 'starting' ? '正在启动…' : state?.status === 'ready' ? '连接本地服务' : '启动本地服务并连接' }}</button><button v-if="state?.managed" type="button" class="subtle-button" :disabled="state.status === 'stopping' || (disabled && state.status !== 'starting')" @click="stop">{{ state.status === 'starting' ? '取消启动' : '停止服务' }}</button></div>
    <label v-if="state" class="auto-index-choice"><input type="checkbox" :checked="state.autoStart" :disabled="working" @change="autoStart(($event.target as HTMLInputElement).checked)"/>打开 App 时自动启动本地服务</label>
    <p class="embedding-hint">首次加载模型需要一些时间。开启自动启动后，关机再打开 App 会恢复服务；退出 App 时，仅停止由它启动的进程。已有服务会直接复用。</p>
    <details><summary>运行环境与启动日志</summary><p class="local-runtime-path">{{ state?.runtimePath ?? '尚未选择运行环境' }}</p><button type="button" class="subtle-button" :disabled="working || state?.managed" @click="choose">选择已安装的运行环境…</button><p class="embedding-hint">选择包含 venv 和 models 的 wemm 目录；复用已下载模型，不会重新下载。</p><pre v-if="state?.log">{{ state.log }}</pre></details>
    <button v-if="state && !state.runtimePath && state.status !== 'ready'" type="button" class="subtle-button" @click="choose">选择运行环境…</button>
    <p v-if="error" role="alert" class="embedding-error">{{ error }}</p>
  </section>
</template>
<style>
.local-embedding-control{padding:18px;border:1px solid var(--line);border-radius:12px;margin-bottom:24px;background:var(--background)}.local-service-heading,.local-service-actions{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.local-service-heading{justify-content:space-between;font-size:13px}.local-service-status{font-size:11px;color:var(--secondary)}.local-service-status.ready{color:#398166}.local-embedding-control .auto-index-choice{display:flex;align-items:center;gap:8px;margin:16px 0}.local-embedding-control .auto-index-choice input{width:auto}.local-runtime-path{overflow-wrap:anywhere}.local-embedding-control pre{max-height:160px;overflow:auto;font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;color:var(--secondary)}
</style>
