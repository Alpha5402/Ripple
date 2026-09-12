<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { RecentWorkspace } from '../host/contract.js';
defineProps<{ workspaces: RecentWorkspace[]; busy: boolean; active?: string }>();
const emit = defineEmits<{ close: []; open: [id: string]; forget: [id: string]; choose: [] }>();
const dialog = ref<HTMLDialogElement>();
onMounted(() => dialog.value?.showModal());
</script>
<template>
  <dialog ref="dialog" class="workspace-dialog" aria-labelledby="workspace-heading" @cancel.prevent="emit('close')">
    <header><h2 id="workspace-heading">最近工作区</h2><button class="subtle-button" :disabled="busy" @click="emit('close')">关闭</button></header>
    <p v-if="!workspaces.length" class="muted">打开过的工作区会显示在这里。</p>
    <ul><li v-for="workspace in workspaces" :key="workspace.id"><button class="workspace-entry" :disabled="busy" @click="emit('open', workspace.id)"><strong>{{ workspace.label }}</strong><small>{{ workspace.location }}</small></button><button class="subtle-button" :disabled="busy || active === workspace.id || active === workspace.location" :aria-label="`移除 ${workspace.label} 的最近记录`" @click="emit('forget', workspace.id)">移除</button></li></ul>
    <button class="primary-button" :disabled="busy" @click="emit('choose')">打开其他工作区…</button>
  </dialog>
</template>
<style>
.workspace-dialog{width:min(520px,calc(100vw - 32px));max-height:75svh;overflow:auto;box-sizing:border-box;border:1px solid #dce4ef;border-radius:18px;padding:24px;color:var(--text,#243657);background:var(--surface,#fff)}
.workspace-dialog::backdrop{background:#14213d40;backdrop-filter:blur(3px)}.workspace-dialog header{display:flex;align-items:center;justify-content:space-between;gap:20px}.workspace-dialog h2{font-size:20px;margin:0}.workspace-dialog ul{list-style:none;margin:20px 0;padding:0}.workspace-dialog li{display:flex;align-items:center;gap:12px;border-bottom:1px solid #e8edf5;padding:8px 0}.workspace-entry{display:grid;gap:6px;flex:1;min-width:0;text-align:left;border:0;border-radius:8px;padding:10px;background:transparent;cursor:pointer;color:inherit}.workspace-entry:hover{background:#edf3fb}.workspace-entry small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#718095}.workspace-entry strong{font-size:14px}.workspace-dialog button:disabled{opacity:.5;cursor:default}
</style>
