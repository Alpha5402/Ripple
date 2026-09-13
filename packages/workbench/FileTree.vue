<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { WorkbenchState } from '../host/contract.js';
import Icon from './Icon.vue';
const props = defineProps<{ documents: WorkbenchState['documents']; active?: string | undefined; visited?: string[] | undefined; searching?: boolean }>();
const emit = defineEmits<{ open: [id: string] }>();
type Entry = { key: string; name: string; path: string; id?: string; children: Entry[] };
const expanded = ref(new Set<string>()), focused = ref('');
const root = ref<HTMLElement>();
const entries = computed(() => {
  const roots: Entry[] = [], folders = new Map<string, Entry>();
  for (const doc of props.documents) {
    const parts = doc.path.split('/'); let children = roots;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let folder = folders.get(path);
      if (!folder) { folder = { key: `folder:${path}`, name: parts[i]!, path, children: [] }; folders.set(path, folder); children.push(folder); }
      children = folder.children;
    }
    children.push({ key: `file:${doc.id}`, name: parts.at(-1)!, path: doc.path, id: doc.id, children: [] });
  }
  const sort = (rows: Entry[]) => { rows.sort((a,b) => Number(!!a.id) - Number(!!b.id) || a.name.localeCompare(b.name, 'zh-CN', { numeric: true })); rows.forEach(row => sort(row.children)); };
  sort(roots); return roots;
});
const visible = computed(() => {
  const rows: { entry: Entry; depth: number; parent?: string; position: number; siblings: number }[] = [];
  const walk = (entries: Entry[], depth: number, parent?: string) => entries.forEach((entry,index) => {
    rows.push({ entry, depth, ...(parent ? { parent } : {}), position: index+1, siblings: entries.length });
    if (!entry.id && expanded.value.has(entry.key)) walk(entry.children, depth+1, entry.key);
  });
  walk(entries.value,1); return rows;
});
function reveal(path: string) { const parts=path.split('/'); for(let i=1;i<parts.length;i++) expanded.value.add(`folder:${parts.slice(0,i).join('/')}`); }
watch(() => props.documents.find(doc=>doc.id===props.active)?.path, path => { if(path) reveal(path); }, {immediate:true});
watch(() => props.searching ? props.documents : undefined, documents => { documents?.forEach(doc=>reveal(doc.path)); }, {immediate:true});
const tabStop = computed(() => visible.value.some(row=>row.entry.key===focused.value) ? focused.value : visible.value.find(row=>row.entry.id===props.active)?.entry.key ?? visible.value[0]?.entry.key);
function activate(entry: Entry) { if(entry.id) emit('open',entry.id); else if(expanded.value.has(entry.key)) expanded.value.delete(entry.key); else expanded.value.add(entry.key); }
async function focusRow(key?: string) { if(!key)return; focused.value=key; await nextTick(); const index=visible.value.findIndex(row=>row.entry.key===key); root.value?.querySelectorAll<HTMLElement>('[role=treeitem]')[index]?.focus(); }
function keyboard(event: KeyboardEvent, index: number) {
  const row=visible.value[index]; if(!row)return;
  const {entry}=row;
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','Enter',' '].includes(event.key))return;
  event.preventDefault();
  if(event.key==='ArrowDown') void focusRow(visible.value[Math.min(index+1,visible.value.length-1)]?.entry.key);
  else if(event.key==='ArrowUp') void focusRow(visible.value[Math.max(0,index-1)]?.entry.key);
  else if(event.key==='Home') void focusRow(visible.value[0]?.entry.key);
  else if(event.key==='End') void focusRow(visible.value.at(-1)?.entry.key);
  else if(event.key==='ArrowRight' && !entry.id) { if(!expanded.value.has(entry.key)) expanded.value.add(entry.key); else void focusRow(entry.children[0]?.key); }
  else if(event.key==='ArrowLeft') { if(!entry.id && expanded.value.has(entry.key)) expanded.value.delete(entry.key); else void focusRow(row.parent); }
  else if(event.key==='Enter'||event.key===' ') activate(entry);
}
</script>
<template>
  <div ref="root" class="file-tree" role="tree" aria-label="知识库文件树">
    <button v-for="(row,index) in visible" :key="row.entry.key" class="file-tree-row" :class="{ 'document-link': !!row.entry.id, active: row.entry.id === active }" role="treeitem" :aria-label="row.entry.name" :aria-level="row.depth" :aria-posinset="row.position" :aria-setsize="row.siblings" :aria-expanded="row.entry.id ? undefined : expanded.has(row.entry.key)" :aria-selected="row.entry.id === active" :aria-current="row.entry.id === active ? 'page' : undefined" :tabindex="row.entry.key === tabStop ? 0 : -1" :title="row.entry.path" :style="{ paddingLeft: `${8+(row.depth-1)*16}px` }" @focus="focused = row.entry.key" @click="activate(row.entry)" @keydown="keyboard($event,index)">
      <span class="tree-chevron" :class="{ expanded: expanded.has(row.entry.key) }" aria-hidden="true">{{ row.entry.id ? '' : '›' }}</span><Icon :name="row.entry.id ? 'note' : 'folder'" :size="15"/><span class="tree-name">{{ row.entry.name }}</span><span v-if="row.entry.id && visited?.includes(row.entry.id)" class="visited-dot" title="已访问"/>
    </button>
  </div>
</template>
<style>
.file-tree{padding:0 0 12px}.file-tree .file-tree-row{width:100%;display:flex;justify-content:flex-start;gap:6px;min-height:29px;margin:0;border-radius:4px;padding-top:5px;padding-bottom:5px;padding-right:8px;color:var(--secondary);font-size:12px;font-weight:400;text-align:left}.file-tree .file-tree-row.active{background:#dee7f7;color:#355eaa}.file-tree .file-tree-row .tree-chevron{width:10px;flex:0 0 10px;height:16px;line-height:14px;font-size:18px;text-align:center;transition:transform .12s}.file-tree .file-tree-row .tree-chevron.expanded{transform:rotate(90deg)}.file-tree-row .tree-name{min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file-tree-row svg{opacity:.75}.file-tree-row:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}@media(prefers-color-scheme:dark){.file-tree .file-tree-row.active{background:#2e405d;color:#c1d3f2}}
</style>
