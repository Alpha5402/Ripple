<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkbenchBridge, WorkbenchState } from '../host/contract.js';
import { knowledgeFilter, MAX_IGNORE_RULES_LENGTH } from '../ingestion/knowledge-filter.js';
import EmbeddingSettings from './EmbeddingSettings.vue';
const props = defineProps<{ bridge: WorkbenchBridge; state: WorkbenchState }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const tab = ref<'knowledge' | 'embedding'>(props.bridge.supportsKnowledgeSettings ? 'knowledge' : 'embedding');
const rules = ref(props.state.knowledgeSettings?.ignoreRules ?? '');
const saving = ref(false), error = ref(''), saved = ref(false);
const changed = computed(() => rules.value !== (props.state.knowledgeSettings?.ignoreRules ?? ''));
const matches = computed(() => { try { const excluded = knowledgeFilter(rules.value); return props.state.documents.filter(d => excluded(d.path)); } catch { return []; } });
async function save() {
  saving.value = true; error.value = ''; saved.value = false;
  try { await props.bridge.command({ type: 'configure-knowledge', ignoreRules: rules.value }); saved.value = true; emit('changed'); }
  catch (cause) { error.value = (cause as Error).message; }
  finally { saving.value = false; }
}
</script>
<template>
  <main class="settings-page" aria-label="工作区设置">
    <header class="settings-topbar"><button class="subtle-button" :disabled="saving" @click="emit('close')">← 返回知识库</button><span>{{ state.label }}</span></header>
    <div class="settings-layout">
      <aside class="settings-navigation"><p>WORKSPACE</p><h1>设置</h1><nav aria-label="设置分类"><button v-if="bridge.supportsKnowledgeSettings" :class="{ active: tab === 'knowledge' }" :aria-current="tab === 'knowledge' ? 'page' : undefined" @click="tab = 'knowledge'">知识范围</button><button v-if="bridge.supportsEmbedding" :class="{ active: tab === 'embedding' }" :aria-current="tab === 'embedding' ? 'page' : undefined" @click="tab = 'embedding'">Embedding 模型</button></nav><p class="settings-local">仅用于当前工作区<br/>设置会在本机保存</p></aside>
      <section class="settings-content">
        <div v-show="tab === 'knowledge'" v-if="bridge.supportsKnowledgeSettings">
          <h2>知识范围</h2><p class="settings-description">排除不想纳入知识库的目录或文件。它们不会参与名称提及、WikiLink 目标解析或向量索引，原文件不会被修改。</p>
          <form @submit.prevent="save">
            <label class="rules-label" for="knowledge-rules">排除规则</label>
            <textarea id="knowledge-rules" v-model="rules" :maxlength="MAX_IGNORE_RULES_LENGTH" :disabled="saving" rows="10" spellcheck="false" placeholder="# 每行一条，路径相对于工作区根目录&#10;Sources/&#10;archive/&#10;**/drafts/&#10;*.tmp.md" aria-describedby="rules-help" @input="saved = false"/>
            <p id="rules-help" class="settings-help">使用 gitignore 语法：<code>目录/</code> 排除目录，<code>/目录/</code> 仅匹配根目录，<code>*</code> 和 <code>**</code> 匹配路径，<code>#</code> 开头为注释，<code>!</code> 表示例外。若父目录已排除，需要先将父目录重新纳入。</p>
            <div class="settings-actions"><button type="submit" class="primary-button" :disabled="saving || !changed">{{ saving ? '正在应用…' : '保存并应用' }}</button><span v-if="saved && !changed" role="status">已保存，知识范围已更新</span></div>
          </form>
          <p v-if="error" role="alert" class="embedding-error">{{ error }}</p>
          <section class="settings-scope-summary"><h3>当前知识库</h3><p>{{ state.documents.length }} 篇笔记参与构建。修改规则后会清理被排除内容的关系与向量记录；重新纳入的笔记将在下次索引时编码。</p><p v-if="changed">当前已加载的笔记中，将排除 {{ matches.length }} 篇。</p><ul v-if="changed && matches.length"><li v-for="doc in matches.slice(0, 12)" :key="doc.id">{{ doc.path }}</li></ul><details v-if="state.knowledgeSettings?.excludedPaths.length"><summary>已排除的路径（{{ state.knowledgeSettings.excludedPaths.length }}）</summary><ul><li v-for="path in state.knowledgeSettings.excludedPaths.slice(0, 100)" :key="path">{{ path }}</li></ul></details><p v-if="state.mode === 'public'" class="settings-help">浏览器保留已导入笔记的本地文本副本，方便撤销排除；被排除文本不进入引用和向量索引。未导入的内容需要重新同步目录。</p></section>
        </div>
        <EmbeddingSettings v-show="tab === 'embedding'" v-if="bridge.supportsEmbedding" embedded :bridge="bridge" :state="state" @changed="emit('changed')"/>
      </section>
    </div>
  </main>
</template>
<style>
.settings-page{height:100svh;overflow:auto;background:var(--surface,#fff);color:var(--text,#243657)}.settings-topbar{height:66px;display:flex;align-items:center;justify-content:space-between;padding:0 36px;border-bottom:1px solid var(--border,#e4e8f0);color:#78869b;font-size:13px}.settings-layout{display:grid;grid-template-columns:190px minmax(0,640px);gap:60px;max-width:1020px;margin:0 auto;padding:48px 32px 72px}.settings-navigation>p:first-child{font-size:10px;letter-spacing:.15em;color:#8a96ab}.settings-navigation h1{font-size:28px;margin:8px 0 30px}.settings-navigation nav{display:grid;gap:8px}.settings-navigation nav button{text-align:left;border:0;border-radius:10px;background:transparent;color:#65748e;padding:13px 16px;font:inherit;font-size:14px;cursor:pointer}.settings-navigation nav button.active{background:#edf1fc;color:#526ec1;font-weight:600}.settings-local{font-size:12px;line-height:1.8;color:#8a96ab;margin:32px 16px}.settings-content h2{font-size:23px;margin:0 0 12px}.settings-description{font-size:14px;line-height:1.8;color:#6a7891;margin:0 0 28px}.rules-label{display:block;font-size:14px;font-weight:600;margin-bottom:12px}.settings-content textarea{display:block;box-sizing:border-box;width:100%;resize:vertical;min-height:200px;max-height:480px;border:1px solid #cdd6e5;border-radius:12px;padding:16px;background:#fbfcff;color:inherit;font:13px/1.8 ui-monospace,SFMono-Regular,monospace}.settings-content textarea:focus-visible{outline:2px solid #698be0;outline-offset:2px}.settings-help{font-size:12px;line-height:1.8;color:#7a879d}.settings-help code{font-size:12px;color:#566782}.settings-actions{display:flex;gap:18px;align-items:center;margin:24px 0;font-size:13px;color:#4e806c}.settings-actions button:disabled{opacity:.5;cursor:default}.settings-scope-summary{border-top:1px solid #e4e8f0;margin-top:32px;padding-top:24px;font-size:13px;line-height:1.8;color:#6a7891}.settings-scope-summary h3{font-size:14px;color:#34496c;margin:0 0 8px}.settings-scope-summary ul{padding-left:20px;overflow-wrap:anywhere}.settings-scope-summary summary{cursor:pointer}.empty-workspace-settings{position:fixed;bottom:32px;left:50%;transform:translateX(-50%)}@media(max-width:700px){.settings-layout{grid-template-columns:1fr;gap:26px;padding:24px}.settings-topbar{padding:0 20px}.settings-navigation h1{margin-bottom:18px}.settings-navigation nav{display:flex}.settings-local{display:none}}
</style>
