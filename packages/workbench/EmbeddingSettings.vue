<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { WorkbenchBridge, WorkbenchState } from '../host/contract.js';
import type { EmbeddingConnection } from '../host/embedding-connection.js';
const props = defineProps<{ bridge: WorkbenchBridge; state: WorkbenchState }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const dialog = ref<HTMLDialogElement>();
const connecting = ref(false), error = ref('');
const form = ref<EmbeddingConnection>({ protocol: 'ripple', baseUrl: 'http://127.0.0.1:8787', model: '', revision: 'default', maxInputTokens: 8192, chunkTokens: 512, batchSize: 1, ...props.state.embeddingConnection, apiKey: '' });
const connectedForm = ref(JSON.stringify(form.value));
const settingsChanged = computed(() => JSON.stringify(form.value) !== connectedForm.value);
const configured = computed(() => props.state.coverage.semantic.status !== 'not-configured');
const coverage = computed(() => props.state.coverage.semantic);
const completed = computed(() => Object.values(coverage.value.documents).filter(doc => doc.status === 'ready').length);
const failures = computed(() => Object.entries(coverage.value.documents).filter(([, doc]) => doc.errors.length).map(([id, doc]) => ({ title: props.state.documents.find(d => d.id === id)?.title ?? id, code: doc.errors[0]?.code ?? doc.status })));
const status = computed(() => props.state.indexing ? '正在建立语义索引' : ({ 'not-configured': '尚未配置模型', ready: '语义索引已就绪', pending: '模型已连接，等待索引', partial: '部分笔记未完成', stale: '内容已变化，待更新索引', error: '索引失败，可重试', cancelled: '索引已取消', 'limit-exceeded': '输入超限，请减小分块', unsupported: '模型不支持当前输入' })[coverage.value.status]);
onMounted(() => dialog.value?.showModal());
async function connect() {
  connecting.value = true; error.value = '';
  try { const result = await props.bridge.command({ type: 'configure-embedding', settings: { ...form.value } }) as WorkbenchState; if (result.embeddingConnection) form.value = { ...result.embeddingConnection, apiKey: '' }; else form.value.apiKey = ''; connectedForm.value = JSON.stringify(form.value); emit('changed'); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { connecting.value = false; }
}
async function index() {
  error.value = '';
  try { await props.bridge.command({ type: props.state.indexing ? 'cancel-index' : 'index' }); emit('changed'); }
  catch (cause) { error.value = (cause as Error).message; }
}
async function setAutoIndex(enabled: boolean) { try { await props.bridge.command({ type: 'auto-index', enabled }); emit('changed'); } catch (e) { error.value = (e as Error).message; } }
function close() { if (!connecting.value) emit('close'); }
</script>
<template>
  <dialog ref="dialog" class="embedding-dialog" aria-labelledby="embedding-heading" @cancel.prevent="close" @close="close">
    <header><div><h2 id="embedding-heading">语义关联</h2><p>连接 Embedding 模型，让内容相近的笔记自然相连。</p></div><button type="button" class="subtle-button" :disabled="connecting" @click="close">关闭</button></header>
    <form @submit.prevent="connect">
      <fieldset :disabled="connecting || state.indexing">
        <label>服务类型<select v-model="form.protocol"><option value="ripple">本地 WeMM / Ripple 服务</option><option value="openai-compatible">兼容 OpenAI 的 Embedding 服务</option></select></label>
        <label>服务地址<input v-model.trim="form.baseUrl" type="url" required placeholder="http://127.0.0.1:8787"/></label>
        <p class="embedding-hint">填写服务根地址或以 /v1 结尾的地址。{{ form.protocol === 'ripple' ? '请先启动本地 WeMM 服务。' : '模型名称应与服务提供方的 Embedding 模型名称一致。' }}</p>
        <label v-if="form.protocol === 'openai-compatible'">模型名称<input v-model.trim="form.model" required placeholder="填写 Embedding 模型名称"/></label>
        <label>API Key（无认证的本地服务可留空）<input v-model="form.apiKey" type="password" autocomplete="off" spellcheck="false" :placeholder="state.mode === 'desktop' ? '通过系统加密保存' : '仅在本次会话中使用'"/></label>
        <details><summary>索引参数</summary><div class="embedding-fields"><label v-if="form.protocol === 'openai-compatible'">模型输入上限<input v-model.number="form.maxInputTokens" type="number" min="64" max="1048576" required/></label><label>每段最大 Token<input v-model.number="form.chunkTokens" type="number" min="64" max="8192" required/></label><label>每批片段数<input v-model.number="form.batchSize" type="number" min="1" max="8" required/></label></div></details>
      </fieldset>
      <p class="embedding-hint">测试连接只发送一小段固定测试文本。点击「开始索引」后，笔记文本会发送到你配置的服务；当前为纯文本索引，不发送图片。</p>
      <button type="submit" class="primary-button" :disabled="connecting || state.indexing">{{ connecting ? '正在测试连接…' : configured ? '测试并更新连接' : '测试并连接' }}</button>
    </form>
    <section class="embedding-progress" aria-live="polite">
      <strong>{{ status }}</strong>
      <p v-if="state.embeddingConnection">{{ state.embeddingConnection.model }}<br/>{{ state.embeddingConnection.baseUrl }}</p><p v-if="configured && settingsChanged" class="embedding-hint">配置已修改，请先测试并更新连接，再开始索引。</p>
      <template v-if="configured"><progress :value="completed" :max="Math.max(1,state.documents.length)"/><p>{{ completed }} / {{ state.documents.length }} 篇笔记 · {{ coverage.readyUnits }} 个片段已索引</p><button type="button" class="primary-button" :disabled="connecting || ((settingsChanged || state.embeddingNeedsAuth) && !state.indexing)" @click="index">{{ state.indexing ? '停止索引' : coverage.readyUnits ? '更新索引' : '开始索引' }}</button></template>
      <p v-if="state.embeddingNeedsAuth" class="embedding-hint">缓存已恢复；请重新输入 API Key 并测试连接，才能更新索引。</p><label v-if="configured" class="auto-index-choice"><input type="checkbox" :checked="state.autoIndex" @change="setAutoIndex(($event.target as HTMLInputElement).checked)"/>自动更新有变化的笔记</label>
      <p v-for="notice in state.notices.slice(0,1)" :key="notice">{{ notice }}</p>
      <ul v-if="failures.length"><li v-for="failure in failures.slice(0,5)" :key="failure.title">{{ failure.title }}：{{ failure.code }}</li></ul>
      <p v-if="state.mode === 'public'" class="embedding-hint">工作区和索引保存在当前浏览器的本地存储；API Key 不写入缓存。目录访问权限失效时需要重新授权。</p>
    </section>
    <p v-if="error" role="alert" class="embedding-error">{{ error }}</p>
  </dialog>
</template>
<style>
.embedding-dialog{width:min(560px,calc(100vw - 32px));max-height:calc(100svh - 48px);box-sizing:border-box;overflow:auto;border:1px solid var(--border,#dde3ed);border-radius:20px;padding:28px;background:var(--surface,#fff);color:var(--text,#243657);box-shadow:0 20px 80px #18284422}
.embedding-dialog::backdrop{background:#14213d40;backdrop-filter:blur(3px)}.embedding-dialog header{display:flex;justify-content:space-between;gap:20px;align-items:start;margin-bottom:22px}.embedding-dialog h2{margin:0 0 8px;font-size:22px}.embedding-dialog p{font-size:13px;line-height:1.6;margin:8px 0 16px}.embedding-dialog fieldset{border:0;padding:0;margin:0;display:grid;gap:15px;min-width:0}.embedding-dialog label{display:grid;gap:7px;font-size:13px}.embedding-dialog input,.embedding-dialog select{box-sizing:border-box;width:100%;min-width:0;border:1px solid #cbd5e4;border-radius:9px;padding:10px 12px;font:inherit;background:var(--surface,#fff);color:inherit}.embedding-dialog input:focus-visible,.embedding-dialog select:focus-visible{outline:2px solid #698be0;outline-offset:2px}.embedding-dialog .embedding-hint{color:#68778e;font-size:12px;margin:0 0 14px}.embedding-dialog summary{cursor:pointer;font-size:13px;margin-bottom:12px}.embedding-fields{display:flex;gap:12px}.embedding-fields label{flex:1}.embedding-dialog button{cursor:pointer}.embedding-dialog button:disabled{opacity:.5;cursor:wait}.embedding-progress{border-top:1px solid #e1e7f0;margin-top:24px;padding-top:20px}.embedding-progress progress{width:100%;height:8px;accent-color:#6985dc}.embedding-dialog .auto-index-choice{display:flex;align-items:center;gap:8px;margin:16px 0}.embedding-dialog .auto-index-choice input{width:auto}
.embedding-error{color:#ae3434}.embedding-progress ul{font-size:12px;color:#ae3434;padding-left:18px}
</style>
