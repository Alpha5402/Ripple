<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount, nextTick, watch, defineAsyncComponent } from 'vue';
import type { RecentWorkspace, GlobalGraph, WorkbenchBridge, WorkbenchState, ReadingDocument, HostCommand, EvidenceResult } from '../host/contract.js';
import type { Relation, EvidenceLocator } from '../core/model.js';
import { renderReading } from './render.js';
import { applyTextareaEdit, textareaSource } from '../host/source-edit.js';
import Icon from './Icon.vue';
import LocalGraph from './LocalGraph.vue';
import Welcome from './Welcome.vue';
import WorkspaceSwitcher from './WorkspaceSwitcher.vue';
import SettingsPage from './SettingsPage.vue';
const MarkEditor = defineAsyncComponent(() => import('./MarkEditor.vue'));

const props = defineProps<{ bridge: WorkbenchBridge }>();
const state = ref<WorkbenchState>();
const reading = ref<ReadingDocument>();
const preview = ref<ReadingDocument>();
const selectedRelation = ref<Relation>();
const evidence = ref<{ locator: EvidenceLocator; result: EvidenceResult }[]>([]);
const mode = ref<'reading' | 'explore' | 'global'>('reading');
const sidebar = ref(true), busy = ref(false), error = ref(''), query = ref(''), searchIds = ref<string[]>(), lens = ref(45);
const editing = ref(false), draft = ref(''), baseline = ref(''), sourceMode = ref(false), draftDialog = ref(false);
const sourceLocation = ref<EvidenceLocator>(), sourceArea = ref<HTMLTextAreaElement>();
const article = ref<HTMLElement>(), searchInput = ref<HTMLInputElement>(), editor = ref<InstanceType<typeof MarkEditor>>();
const readonlyOpen = ref(true), popup = ref(false), statusExpanded = ref(false);
const settingsOpen = ref(false), workspaceSwitcher = ref(false);
const recentWorkspaces = ref<RecentWorkspace[]>([]);
async function loadRecents() { try { recentWorkspaces.value = await props.bridge.recentWorkspaces?.() ?? []; } catch {} }
async function openRecent(id: string) {
  workspaceSwitcher.value = false;
  await navigate(async () => { if (await props.bridge.openRecent?.(id)) { reading.value = undefined; globalGraph.value = undefined; globalView.value = {}; workspaceSwitcher.value = false; await reload(); await loadRecents(); } });
}
async function forgetWorkspace(id: string) { try { await props.bridge.forgetWorkspace?.(id); await loadRecents(); } catch (e) { error.value = (e as Error).message; } }

const globalGraph = ref<GlobalGraph>(), globalLens = ref(100), globalLoading = ref(false);
const globalView = ref<{ layout?: Record<string, { x: number; y: number }>; camera?: { x: number; y: number; zoom: number } }>({});
const visibleGlobal = computed(() => globalGraph.value ? { ...globalGraph.value, relations: globalGraph.value.relations.filter(r => r.score >= 1 - globalLens.value / 100) } : undefined);
let globalSequence = 0;
async function loadGlobal() {
  const token = ++globalSequence; globalLoading.value = true;
  try { const result = await props.bridge.command({ type: 'global-graph' }) as GlobalGraph; if (token === globalSequence) globalGraph.value = result; }
  catch (e) { if (token === globalSequence) error.value = (e as Error).message; }
  finally { if (token === globalSequence) globalLoading.value = false; }
}
watch(() => [mode.value, state.value?.workspaceId ?? state.value?.label, state.value?.coverage.indexRevision, state.value?.indexing], () => {
  if (mode.value === 'global' && !state.value?.indexing) void loadGlobal();
});
function graphView(view: typeof globalView.value) {
  if (mode.value === 'global') globalView.value = { ...globalView.value, ...view };
  else void props.bridge.command({ type: 'view', ...view }).catch(e => error.value = e.message);
}
function exploreNode(id: string) { void navigate(async () => { await command({ type: 'focus', id }, true); mode.value = 'explore'; }); }

const mobile = ref(false), contextOpen = ref(false);
let unsubscribe = () => {}, pendingNavigation: (() => Promise<void>) | undefined, readSequence = 0, previewSequence = 0, lensSequence = 0, searchSequence = 0;
let queryTimer: ReturnType<typeof setTimeout>, scrollTimer: ReturnType<typeof setTimeout>;
let previousFocus: HTMLElement | null = null;
const displayDraft = computed(() => textareaSource(draft.value));
const dirty = computed(() => editing.value && draft.value !== baseline.value);
const documents = computed(() => state.value?.documents.filter(d => !searchIds.value || searchIds.value.includes(d.id)) ?? []);
const groups = computed(() => {
  const result = new Map<string, typeof documents.value>();
  for (const document of documents.value) { const group = document.path.includes('/') ? document.path.split('/').slice(0, -1).join(' / ') : '知识笔记'; const list = result.get(group) ?? []; list.push(document); result.set(group, list); }
  return [...result];
});
const titles = computed(() => new Map(state.value?.documents.map(d => [d.id, d.title]) ?? []));
const currentTitle = computed(() => titles.value.get(state.value?.current?.snapshot.focusNode ?? '') ?? '知识从这里展开');
const body = computed(() => reading.value ? renderReading(reading.value) : '');
const previewBody = computed(() => preview.value ? renderReading(preview.value) : '');
const relationKinds = (relation: Relation) => [...new Set(relation.signals.map(s => ({ mention: '名称提及', explicit: '显式链接', semantic: '语义相似' })[s.kind]))];
const other = (relation: Relation) => relation.nodes.find(id => id !== state.value?.current?.snapshot.focusNode)!;
const previewRelation = computed(() => state.value?.visible?.relations.find(r => r.nodes.includes(preview.value?.document.id ?? '')));
watch(dirty, value => props.bridge.setDirty?.(value));
watch(draftDialog, async value => { if (value) { previousFocus = document.activeElement as HTMLElement; await nextTick(); document.querySelector<HTMLButtonElement>('.dialog button')?.focus(); } else previousFocus?.focus(); });
watch(query, () => { clearTimeout(queryTimer); const token = ++searchSequence; queryTimer = setTimeout(async () => { if (!query.value.trim()) { searchIds.value = undefined; return; } try { const hits = await props.bridge.command({ type: 'search', query: query.value }) as { documentId: string }[]; if (token === searchSequence) searchIds.value = hits.map(h => h.documentId); } catch (e) { error.value = (e as Error).message; } }, 160); });
async function loadReading(id: string, offset = 0) {
  const token = ++readSequence; const result = await props.bridge.command({ type: 'read', id }) as ReadingDocument;
  if (token !== readSequence) return;
  reading.value = result; if (sourceLocation.value && sourceLocation.value.revision !== result.document.revision) sourceLocation.value = undefined; await nextTick(); if (article.value) article.value.scrollTop = offset;
}
async function apply(next: WorkbenchState, restoreReading = false) {
  if (next.workspaceId !== state.value?.workspaceId) { reading.value = undefined; globalGraph.value = undefined; globalView.value = {}; void loadRecents(); }
  if (!next.documents.some(d => d.id === reading.value?.document.id)) reading.value = undefined;
  state.value = next; lens.value = next.current?.snapshot.lensValue ?? 45;
  const id = next.current?.reading?.documentId ?? next.current?.snapshot.focusNode;
  if (id && (!reading.value || restoreReading || reading.value.document.id !== id || (!editing.value && next.documents.find(d => d.id === id)?.revision !== reading.value.document.revision))) {
    await loadReading(id, next.current?.reading?.offset ?? 0).catch(() => { reading.value = undefined; });
  }
}
async function command(c: HostCommand, restoreReading = false) { const next = await props.bridge.command(c) as WorkbenchState; await apply(next, restoreReading); }
async function reload() { try { await apply(await props.bridge.command({ type: 'state' }) as WorkbenchState); } catch (e) { if ((e as { code?: string }).code !== 'NOT_FOUND') error.value = (e as Error).message; } }
async function navigate(action: () => Promise<void>) {
  if (dirty.value) { pendingNavigation = action; draftDialog.value = true; return; }
  editing.value = false; sourceLocation.value = undefined; popup.value = false; selectedRelation.value = undefined; preview.value = undefined; error.value = '';
  try { busy.value = true; await flushReading(); await action(); } catch (e) { error.value = (e as Error).message; } finally { busy.value = false; }
}
function focus(id: string) { void navigate(() => command({ type: 'focus', id }, true)); }
async function flushReading() { clearTimeout(scrollTimer); if (reading.value && state.value?.current && article.value) await props.bridge.command({ type: 'view', reading: { documentId: reading.value.document.id, offset: article.value.scrollTop } }); }
function onScroll() { clearTimeout(scrollTimer); scrollTimer = setTimeout(() => { void flushReading().catch(() => {}); }, 200); }
async function setLens(value: number) {
  lens.value = value; const token = ++lensSequence;
  try { const next = await props.bridge.command({ type: 'lens', value }) as WorkbenchState; if (token === lensSequence) { state.value = next; } } catch (e) { error.value = (e as Error).message; }
}
async function showPreview(id: string, isPopup = false) {
  const token = ++previewSequence;
  try { const result = await props.bridge.command({ type: 'read', id }) as ReadingDocument; if (token !== previewSequence) return; preview.value = result; popup.value = isPopup; contextOpen.value = true; selectedRelation.value = undefined; } catch (e) { error.value = (e as Error).message; }
}
async function showEvidence(id: string) {
  const relation = (mode.value === 'global' ? globalGraph.value?.relations : [...state.value?.current?.snapshot.candidateSet ?? [], ...state.value?.current?.snapshot.neighborhoodRelations ?? []])?.find(r => r.id === id); if (!relation) return;
  selectedRelation.value = relation; popup.value = false; preview.value = undefined; evidence.value = []; contextOpen.value = true;
  const locators = [...new Map(relation.signals.flatMap(s => s.evidence).map(locator => [JSON.stringify(locator), locator])).values()];
  try {
    const results = await Promise.all(locators.map(async locator => ({ locator, result: await props.bridge.command({ type: 'evidence', locator }) as EvidenceResult })));
    if (selectedRelation.value?.id === id) evidence.value = results;
  } catch (cause) { error.value = (cause as Error).message; selectedRelation.value = undefined; }
}
function mention(event: MouseEvent, click = false) {
  const target = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-reference]');
  if (!target) { if (click && (event.target as HTMLElement).closest('a')) event.preventDefault(); return; }
  const source = (event.currentTarget as HTMLElement).classList.contains('preview-body') ? preview.value : reading.value;
  const reference = [...source?.mentions ?? [], ...source?.links ?? []].find(ref => ref.id === target.dataset.reference);
  if (reference?.resolution.status === 'resolved' && reference.resolution.candidates[0]) { event.preventDefault(); void showPreview(reference.resolution.candidates[0].documentId, mode.value === 'reading'); }
}
async function openEvidence(locator: EvidenceLocator) {
  await navigate(async () => {
    await loadReading(locator.documentId);
    if (reading.value?.document.revision !== locator.revision) throw new Error('来源已经更新，请刷新关系后重新定位。');
    mode.value = 'reading'; sourceLocation.value = locator;
    await props.bridge.command({ type: 'view', reading: { documentId: locator.documentId, offset: 0 } });
    await nextTick();
    const area = sourceArea.value;
    if (area) {
      const domOffset = (offset: number) => reading.value!.document.markdown.slice(0, offset).replace(/\r\n?/g, '\n').length;
      area.focus(); area.setSelectionRange(domOffset(locator.start), domOffset(locator.end));
      const line = reading.value.document.markdown.slice(0, locator.start).split(/\r?\n/).length - 1;
      area.scrollTop = Math.max(0, line * (parseFloat(getComputedStyle(area).lineHeight) || 23) - area.clientHeight / 3);
    }
  });
}
function startEdit() { if (!reading.value) return; sourceLocation.value = undefined; baseline.value = reading.value.document.markdown; draft.value = baseline.value; mode.value = 'reading'; editing.value = true; sourceMode.value = false; error.value = ''; }
async function save() {
  if (!reading.value) return false;
  try {
    busy.value = true; await command({ type: 'save', id: reading.value.document.id, expectedHash: reading.value.document.contentHash, markdown: draft.value });
    editing.value = false; await loadReading(reading.value.document.id, article.value?.scrollTop ?? 0); error.value = ''; return true;
  } catch (e) { error.value = (e as Error).message; return false; } finally { busy.value = false; }
}
async function resolveDraft(action: 'save' | 'discard' | 'cancel') {
  if (action === 'cancel') { draftDialog.value = false; pendingNavigation = undefined; return; }
  if (action === 'save' && !await save()) { draftDialog.value = false; return; }
  editing.value = false; draftDialog.value = false; const next = pendingNavigation; pendingNavigation = undefined; if (next) await navigate(next);
}
async function chooseFolder() { if (!props.bridge.chooseFolder) return; workspaceSwitcher.value = false; if (dirty.value) { pendingNavigation = chooseFolder; draftDialog.value = true; return; } try { if (await props.bridge.chooseFolder(readonlyOpen.value)) { editing.value = false; reading.value = undefined; globalGraph.value = undefined; globalView.value = {}; error.value = ''; workspaceSwitcher.value = false; await reload(); await loadRecents(); } } catch (cause) { error.value = (cause as Error).message; } }
function keyboard(event: KeyboardEvent) {
  if (draftDialog.value) {
    if (event.key === 'Escape') { event.preventDefault(); void resolveDraft('cancel'); }
    if (event.key === 'Tab') {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>('.dialog button')];
      if (event.shiftKey && document.activeElement === buttons[0]) { event.preventDefault(); buttons.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === buttons.at(-1)) { event.preventDefault(); buttons[0]?.focus(); }
    }
    return;
  }
  if (settingsOpen.value) return;
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.key.toLowerCase() === 'k') { event.preventDefault(); sidebar.value = true; void nextTick(() => searchInput.value?.focus()); }
  if (event.key.toLowerCase() === 's' && editing.value) { event.preventDefault(); void save(); }
  if (event.key === '[' && !editing.value && state.value?.canBack) { event.preventDefault(); void navigate(() => command({ type: 'back' }, true)); }
}
const preventUnload = (event: BeforeUnloadEvent) => { if (dirty.value) event.preventDefault(); };
const resized = () => { const narrow = window.innerWidth <= 700; if (narrow && !mobile.value) sidebar.value = false; mobile.value = narrow; };
onMounted(() => { void loadRecents(); resized(); sidebar.value = !mobile.value && !new URLSearchParams(location.search).has('embed'); void reload(); unsubscribe = props.bridge.subscribe(() => { void reload(); }); window.addEventListener('keydown', keyboard); window.addEventListener('beforeunload', preventUnload); window.addEventListener('resize', resized); });
onBeforeUnmount(() => { unsubscribe(); clearTimeout(queryTimer); clearTimeout(scrollTimer); window.removeEventListener('keydown', keyboard); window.removeEventListener('beforeunload', preventUnload); window.removeEventListener('resize', resized); props.bridge.setDirty?.(false); });
</script>
<template>
  <SettingsPage v-if="settingsOpen && state" :bridge="bridge" :state="state" @close="settingsOpen = false" @changed="reload"/>
  <Welcome v-else-if="!state?.documents.length" :can-open="!!bridge.chooseFolder" :error="error" :recent-workspaces="recentWorkspaces" @open="chooseFolder" @recent="openRecent"/>
  <div v-else class="workbench" :class="{ 'sidebar-hidden': !sidebar, desktop: state?.mode === 'desktop', 'is-exploring': mode !== 'reading' }">
    <aside :inert="draftDialog" class="library-sidebar" aria-label="知识目录" v-show="sidebar">
      <button v-if="mobile" class="icon-button mobile-sidebar-close" aria-label="关闭知识目录" @click="sidebar = false"><Icon name="close" :size="18"/></button>
      <div class="sidebar-brand"><img class="sidebar-logo" :src="'./brand/ripple-logo.png'" alt="" width="36" height="36"/><strong>Ripple</strong></div>
      <div class="library-label"><span>{{ state?.label ?? '你的知识空间' }}</span><span>{{ state?.documents.length ?? 0 }}</span></div>
      <label class="search-field"><Icon name="search" :size="16"/><input ref="searchInput" v-model="query" placeholder="搜索笔记" aria-label="搜索笔记"/><kbd>⌘K</kbd></label>
      <nav class="document-tree">
        <details v-for="[group, docs] in groups" :key="group" open><summary><Icon name="folder" :size="15"/><span>{{ group }}</span><small>{{ docs.length }}</small></summary><button v-for="doc in docs" :key="doc.id" class="document-link" :class="{ active: state?.current?.snapshot.focusNode === doc.id }" :aria-current="state?.current?.snapshot.focusNode === doc.id ? 'page' : undefined" @click="focus(doc.id)"><Icon name="note" :size="15"/><span>{{ doc.title }}</span><span class="visited-dot" v-if="state?.current?.visited.includes(doc.id)" title="已访问"/></button></details>
        <p class="muted empty-search" v-if="query && !documents.length">没有匹配的笔记</p>
      </nav>
      <div class="sidebar-bottom"><button class="workspace-status" @click="statusExpanded = !statusExpanded"><span class="status-dot" :class="{ indexing: state?.indexing }"/><span>{{ state?.indexing ? '正在整理语义关联' : '知识库已就绪' }}</span><Icon name="more" :size="16"/></button><template v-if="statusExpanded"><div class="status-details"><p>{{ state?.coverage.deterministic.documents ?? 0 }} 篇笔记 · {{ state?.readOnly ? '只读目录' : state?.mode === 'public' ? '浏览器沙盒' : '可编辑目录' }}</p><p v-for="notice in state?.notices" :key="notice">{{ notice }}</p><p v-if="state?.syncStatus">{{ state.syncStatus }}</p><button v-if="state?.mode === 'public'" @click="navigate(() => command({ type: 'refresh' }))">同步目录</button><p v-if="state?.autoIndex">自动增量索引已开启</p><p>语义索引：{{ state?.indexing ? '正在索引' : state?.coverage.semantic.status === 'not-configured' ? '尚未配置' : state?.coverage.semantic.status === 'ready' ? '已就绪' : '待更新 / 部分完成' }} · {{ state?.coverage.semantic.readyUnits ?? 0 }} 个片段</p><button v-if="bridge.chooseEmbedding && !bridge.supportsEmbedding" @click="bridge.chooseEmbedding?.().then(reload)">连接模型…</button><button v-if="!bridge.supportsEmbedding && state?.mode === 'desktop' && state?.coverage.semantic.status !== 'not-configured'" @click="command({ type: state?.indexing ? 'cancel-index' : 'index' })">{{ state?.indexing ? '取消索引' : '增量索引' }}</button></div></template><button v-if="bridge.recentWorkspaces" class="open-folder" @click="loadRecents(); workspaceSwitcher = true">最近工作区…</button><button v-if="bridge.supportsEmbedding || bridge.supportsKnowledgeSettings" class="open-folder" @click="navigate(async () => { settingsOpen = true; })">设置…</button><template v-if="bridge.chooseFolder"><label v-if="state?.mode === 'desktop'" class="readonly-choice"><input type="checkbox" v-model="readonlyOpen"/>只读打开新目录</label><button class="open-folder" @click="chooseFolder"><Icon name="folder" :size="16"/>打开工作区…</button></template><span v-else class="public-footnote">{{ state?.mode === 'harness' ? 'Harness · 只读知识工作台' : '本地知识 · 浏览器沙盒' }}</span></div>
    </aside>
    <main :inert="draftDialog" class="main-space">
      <header class="toolbar"><div class="toolbar-leading"><button class="icon-button" :aria-label="sidebar ? '收起目录' : '展开目录'" @click="sidebar = !sidebar"><Icon name="sidebar"/></button><button class="icon-button" aria-label="返回上一个探索中心" :disabled="!state?.canBack || busy" @click="navigate(() => command({ type: 'back' }, true))"><Icon name="back"/></button><span class="toolbar-divider"/><div class="breadcrumb"><span>知识空间</span><Icon name="back" :size="12" class="breadcrumb-chevron"/><strong>{{ currentTitle }}</strong></div></div><div class="view-switch" role="group" aria-label="工作台视图"><button :class="{ active: mode === 'reading' }" :aria-pressed="mode === 'reading'" @click="mode = 'reading'"><Icon name="book" :size="15"/>阅读</button><button :class="{ active: mode === 'explore' }" :aria-pressed="mode === 'explore'" @click="navigate(async () => { mode = 'explore'; })"><Icon name="graph" :size="15"/>探索</button><button v-if="bridge.supportsGlobalGraph" :class="{ active: mode === 'global' }" :aria-pressed="mode === 'global'" @click="navigate(async () => { mode = 'global'; })"><Icon name="graph" :size="15"/>全局</button></div><div class="toolbar-trailing"><button v-if="mobile" class="icon-button" aria-label="显示或关闭关联面板" @click="contextOpen = !contextOpen"><Icon name="evidence"/></button><span class="readonly-badge" v-if="state?.readOnly">只读</span><button class="icon-button" aria-label="重新扫描并刷新关系" @click="navigate(() => command({ type: 'refresh' }, true))"><Icon name="refresh"/></button><button v-if="reading && !state?.readOnly && !editing" class="subtle-button" @click="startEdit"><Icon name="edit" :size="15"/>编辑</button></div></header>
      <div class="error-banner" role="alert" v-if="error"><span>{{ error }}</span><button @click="error = ''" aria-label="关闭错误提示"><Icon name="close" :size="15"/></button></div>
      <div class="stale-banner" v-if="state?.visible && state.visible.status !== 'current'"><span>知识内容已变化，当前关联需要刷新。</span><button @click="navigate(() => command({ type: 'refresh' }, true))">刷新关联</button></div>
      <template v-if="state?.current && reading">
        <div class="workspace-content">
          <section class="primary-panel">
            <div v-if="mode === 'reading'" class="reading-frame">
              <div class="reading-topline"><span><span class="tiny-dot"/>{{ editing ? (dirty ? '有未保存的编辑' : '编辑模式') : 'READ & CONNECT' }}</span><span>{{ reading.document.markdown.length.toLocaleString() }} 字符<span class="middot">·</span>r{{ reading.document.revision }}</span></div>
              <div v-if="editing" class="editor-toolbar"><span>Mark-it</span><button :class="{ active: sourceMode }" @click="sourceMode = !sourceMode">{{ sourceMode ? '返回富文本' : 'Markdown 源码' }}</button><span class="spacer"/><button @click="navigate(async () => { await loadReading(reading!.document.id); })">结束编辑</button><button class="primary-button" :disabled="busy" @click="save">保存 <kbd>⌘S</kbd></button></div>
              <div v-if="editing" class="editor-scroll"><textarea v-if="sourceMode" class="source-editor" aria-label="Markdown 源码编辑器" :value="displayDraft" @input="draft = applyTextareaEdit(draft, ($event.target as HTMLTextAreaElement).value)" spellcheck="false"/><MarkEditor v-else ref="editor" :source="draft" @change="draft = $event"/></div>
              <div v-else-if="sourceLocation" class="source-location"><div class="editor-toolbar"><span>来源原文 · {{ reading.document.parsed.title }} · 已选中引用</span><span class="spacer"/><button @click="sourceLocation = undefined">返回阅读</button></div><textarea ref="sourceArea" class="source-editor" aria-label="关系来源原文" :value="reading.document.markdown" readonly wrap="off" spellcheck="false"/></div>
              <article v-else ref="article" class="reading-body prose" @scroll="onScroll" @click="mention($event, true)" @mouseover="mention($event)" v-html="body"/>
              <div class="reading-footer"><span><Icon name="sparkle" :size="14"/>带下划线的自然提及可预览关联笔记</span><button v-if="reading.document.id !== state.current.snapshot.focusNode" @click="focus(reading.document.id)">以本文为中心 <Icon name="arrow" :size="14"/></button><button v-else @click="navigate(async () => { mode = 'explore'; })">展开知识 <Icon name="arrow" :size="14"/></button></div>
            </div>
            <div v-else-if="mode === 'global' && !globalGraph" class="reading-loading" role="status">{{ globalLoading ? '正在汇总全局知识网络…' : '暂时无法读取全局网络，请重新切换视图。' }}</div>
            <LocalGraph v-else :key="mode" :state="state" :global-graph="mode === 'global' ? visibleGlobal : undefined" :saved-view="mode === 'global' ? globalView : undefined" :selected="selectedRelation?.id" @preview="showPreview" @focus="exploreNode" @evidence="showEvidence" @view="graphView"/>
          </section>
          <aside v-show="!mobile || contextOpen" class="context-panel" aria-label="关联与证据"><button v-if="mobile" class="mobile-panel-close icon-button" aria-label="关闭关联面板" @click="contextOpen = false"><Icon name="close"/></button>
            <template v-if="selectedRelation"><div class="panel-heading"><span class="eyebrow">RELATION EVIDENCE</span><button class="icon-button" aria-label="关闭证据" @click="selectedRelation = undefined"><Icon name="close" :size="16"/></button></div><h2>为何相连</h2><p class="relation-between">{{ titles.get(selectedRelation.nodes[0]) }}<span>↔</span>{{ titles.get(selectedRelation.nodes[1]) }}</p><div class="score-summary"><strong>{{ Math.round(selectedRelation.score * 100) }}<small>/ 100</small></strong><span>关系强度</span></div><div class="signal-tags"><span v-for="kind in relationKinds(selectedRelation)" :key="kind">{{ kind }}</span></div><div class="signal-directions"><p v-for="(signal, signalIndex) in selectedRelation.signals" :key="signalIndex">{{ titles.get(signal.from) }} <span>{{ signal.kind === 'semantic' ? '↔' : '→' }}</span> {{ titles.get(signal.to) }}</p></div><div class="evidence-list"><section v-for="(entry, index) in evidence" :key="index" class="evidence-card"><div><Icon name="note" :size="14"/><strong>{{ titles.get(entry.locator.documentId) }}</strong><span>r{{ entry.locator.revision }}</span></div><blockquote>{{ entry.result.status === 'valid' ? entry.result.excerpt ?? entry.result.text : '该片段的来源版本已变化，请刷新后重试。' }}</blockquote><button :disabled="entry.result.status !== 'valid'" @click="openEvidence(entry.locator)">定位原文 <Icon name="arrow" :size="13"/></button></section><p v-if="!evidence.length" class="muted">正在读取来源…</p></div><button class="panel-action" @click="focus(other(selectedRelation))">以关联笔记为中心 <Icon name="arrow" :size="15"/></button></template>
            <template v-else-if="preview && !popup"><div class="panel-heading"><span class="eyebrow">NOTE PREVIEW</span><button class="icon-button" aria-label="关闭预览" @click="preview = undefined"><Icon name="close" :size="16"/></button></div><h2>{{ preview.document.parsed.title }}</h2><div class="preview-body prose" @click="mention($event, true)" v-html="previewBody"/><button v-if="previewRelation" class="panel-action secondary" @click="showEvidence(previewRelation.id)"><Icon name="evidence" :size="15"/>查看关联依据</button><button class="panel-action" @click="focus(preview.document.id)">以此为中心 <Icon name="arrow" :size="15"/></button></template>
            <template v-else-if="mode === 'global'"><div class="panel-heading"><span class="eyebrow">KNOWLEDGE NETWORK</span></div><h2>整个知识空间</h2><p class="panel-description">{{ globalGraph?.documents.length ?? 0 }} 篇笔记 · {{ visibleGlobal?.relations.length ?? 0 }} 条关联</p><p class="panel-description">包含没有连线的笔记。点击节点预览，双击进入局部探索；点击连线查看两篇笔记之间的证据。</p><p class="panel-description">{{ globalLoading ? '正在更新关系…' : '拖动节点整理布局，使用 Lens 筛选关系强度。' }}</p></template>
            <template v-else><div class="panel-heading"><span class="eyebrow">CONNECTED NOTES</span><span class="count-badge">{{ state.visible?.relations.length ?? 0 }}</span></div><h2>由此及彼</h2><p class="panel-description">沿着关联，发现下一篇值得读的笔记。</p><div class="related-list"><section v-for="relation in state.visible?.relations" :key="relation.id" class="related-card"><button class="related-title" @click="showPreview(other(relation))"><span class="note-glyph"><Icon name="note" :size="17"/></span><span>{{ titles.get(other(relation)) }}</span><Icon name="arrow" :size="14"/></button><div class="related-meta"><span>{{ relationKinds(relation).join(' · ') }}</span><button :aria-label="`查看 ${titles.get(other(relation))} 的关系证据`" @click="showEvidence(relation.id)">{{ Math.round(relation.score * 100) }} <Icon name="evidence" :size="12"/></button></div></section><div class="empty-relations" v-if="!state.visible?.relations.length"><Icon name="graph" :size="34"/><p>这一层还很安静</p><span>把 Lens 向「拓展」移动，<br/>看看更远的关联。</span></div></div><button v-if="state.visible?.remainingCount" class="panel-action secondary" @click="command({ type: 'more' })">再展开 {{ Math.min(40, state.visible.remainingCount) }} 条关联</button><div class="relation-note"><Icon name="evidence" :size="16"/><p>每一条关系，都有出处。<br/><span>点击分数查看原文与证据。</span></p></div></template>
          </aside>
        </div>
        <footer v-if="mode === 'global'" class="lens-dock"><div class="lens-intro"><span class="lens-symbol"><Icon name="graph" :size="21"/></span><div><strong>Knowledge Lens</strong><span>筛选整库关联 · 保留所有笔记</span></div></div><div class="lens-range"><div class="lens-labels"><span>聚焦</span><span class="lens-value">{{ globalLens }} <small>/ 100</small></span><span>拓展</span></div><input v-model.number="globalLens" type="range" min="0" max="100" :style="{ '--range-progress': `${globalLens}%` }" aria-label="全局 Knowledge Lens"/></div><div class="lens-count"><strong>{{ visibleGlobal?.relations.length ?? 0 }} <span>个关联</span></strong><small>{{ globalGraph?.documents.length ?? 0 }} 篇笔记 · 强度 ≥ {{ 100 - globalLens }}</small></div></footer>
        <footer v-else class="lens-dock"><div class="lens-intro"><span class="lens-symbol"><Icon name="graph" :size="21"/></span><div><strong>Knowledge Lens</strong><span>调节关联的可见范围</span></div></div><div class="lens-range"><div class="lens-labels"><span>Focus · 聚焦</span><span>Explore · 拓展</span></div><input type="range" min="0" max="100" step="1" :value="lens" :style="{ '--range-progress': `${lens}%` }" aria-label="Knowledge Lens，从聚焦到拓展" :aria-valuetext="`当前有效邻域的拓展程度 ${lens}%`" @input="setLens(Number(($event.target as HTMLInputElement).value))"/></div><div class="lens-count"><strong>{{ state.visible?.relations.length ?? 0 }} <span>个关联</span></strong><small>在当前有效邻域内探索</small></div></footer>
      </template>
      <div v-else class="reading-loading" role="status">正在打开笔记…</div>
    </main>
    <div v-if="popup && preview" class="mention-popover" role="dialog" aria-label="自然提及预览"><div class="panel-heading"><span class="eyebrow">自然提及</span><button class="icon-button" aria-label="关闭提及预览" @click="popup = false; preview = undefined"><Icon name="close" :size="16"/></button></div><h3>{{ preview.document.parsed.title }}</h3><p>{{ preview.document.markdown.slice(preview.document.parsed.contentStart ?? 0).replace(/^#.+\n/, '').slice(0, 170) }}…</p><button class="panel-action" @click="focus(preview.document.id)">阅读并探索 <Icon name="arrow" :size="14"/></button></div>
    <WorkspaceSwitcher v-if="workspaceSwitcher" :workspaces="recentWorkspaces" :active="state?.workspaceId" :busy="busy" @close="workspaceSwitcher = false" @open="openRecent" @forget="forgetWorkspace" @choose="chooseFolder"/>
    <div v-if="draftDialog" class="modal-backdrop"><section class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="draft-title"><h2 id="draft-title">这篇笔记还有未保存的编辑</h2><p>保存后继续，或返回检查你的草稿。</p><div><button autofocus @click="resolveDraft('cancel')">返回编辑</button><button @click="resolveDraft('discard')">丢弃编辑</button><button class="primary-button" @click="resolveDraft('save')">保存并继续</button></div></section></div>
  </div>
  <button v-if="!settingsOpen && !state?.documents.length && state?.workspaceId && bridge.supportsKnowledgeSettings" class="subtle-button empty-workspace-settings" @click="settingsOpen = true">设置知识范围</button>
</template>
