<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { summarizeScope, type FolderSelection } from '../ingestion/scope-preview.js';
import { MAX_IGNORE_RULES_LENGTH } from '../ingestion/knowledge-filter.js';
const props = defineProps<{ selection: FolderSelection; busy: boolean; error: string }>();
const emit = defineEmits<{ confirm: [rules: string]; cancel: [] }>();
const dialog = ref<HTMLDialogElement>();
const rules = ref(props.selection.ignoreRules);
const summary = computed(() => { try { return summarizeScope(props.selection.paths, rules.value); } catch { return undefined; } });
onMounted(() => dialog.value?.showModal());
function exclude(path: string) { rules.value += `${rules.value && !rules.value.endsWith('\n') ? '\n' : ''}/${path}/\n`; }
</script>
<template>
  <dialog ref="dialog" class="import-scope" aria-labelledby="import-title" @cancel.prevent="!busy && emit('cancel')">
    <header><span class="eyebrow">KNOWLEDGE SCOPE</span><h2 id="import-title">确认导入范围</h2><p>{{ selection.label }} · 尚未导入或索引</p></header>
    <p class="scope-hint">先检查目录与笔记数量。隐藏目录、符号链接（桌面版）和 AGENTS.md 不纳入统计；不修改源文件。</p>
    <label for="import-rules">排除规则 · gitignore 语法</label><textarea id="import-rules" v-model="rules" :maxlength="MAX_IGNORE_RULES_LENGTH" :disabled="busy" rows="4" placeholder="Templates/&#10;Sources/&#10;**/drafts/"/>
    <p v-if="summary" class="scope-totals" aria-live="polite">纳入 <strong>{{ summary.included }}</strong> 篇 · 排除 <strong>{{ summary.excluded }}</strong> 篇 · {{ summary.directories.length }} 个含笔记目录</p>
    <div class="scope-table"><table v-if="summary"><thead><tr><th>目录（含子目录）</th><th>纳入</th><th>排除</th><th>操作</th></tr></thead><tbody><tr v-for="row in summary.directories" :key="row.path"><td>{{ row.path }}</td><td>{{ row.included }}</td><td>{{ row.excluded }}</td><td><button v-if="row.path !== '(根目录)' && row.included" :disabled="busy" @click="exclude(row.path)">排除此目录</button></td></tr></tbody></table></div>
    <p v-if="!summary || error" role="alert">{{ error || '排除规则无效，请检查后重试。' }}</p>
    <footer><button :disabled="busy" @click="emit('cancel')">取消</button><button class="primary-button" :disabled="busy || !summary || !summary.included" @click="emit('confirm', rules)">{{ busy ? '正在导入…' : '确认并导入' }}</button></footer>
  </dialog>
</template>
<style>
.import-scope{width:min(720px,calc(100vw - 40px));max-height:85vh;overflow:auto;border:1px solid var(--line);border-radius:18px;padding:28px;background:var(--surface);color:var(--ink);box-shadow:0 24px 80px #15274530}.import-scope::backdrop{background:#1a29444d;backdrop-filter:blur(3px)}.import-scope h2{margin:10px 0}.import-scope p{font-size:13px;line-height:1.7;color:var(--secondary)}.import-scope label{display:block;font-size:13px;margin-bottom:10px}.import-scope textarea{width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;resize:vertical;background:var(--background);color:var(--ink);font-size:13px}.scope-totals strong{color:var(--accent)}.scope-table{max-height:260px;overflow:auto}.scope-table table{width:100%;font-size:12px;border-collapse:collapse}.scope-table th,.scope-table td{text-align:left;padding:10px;border-bottom:1px solid var(--line)}.scope-table td:first-child{overflow-wrap:anywhere}.scope-table button{font-size:11px;color:var(--accent);white-space:nowrap}.import-scope footer{display:flex;justify-content:flex-end;gap:16px;margin-top:24px}
</style>
