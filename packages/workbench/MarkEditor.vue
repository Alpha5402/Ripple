<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import { mountMarkIt, type EditorAdapter } from './editor-adapter.js';
const props = defineProps<{ source: string }>();
const emit = defineEmits<{ change: [source: string] }>();
const root = ref<HTMLDivElement>(); let adapter: EditorAdapter | undefined;
onMounted(() => { adapter = mountMarkIt(root.value!, props.source, source => emit('change', source)); adapter.focus(); });
onBeforeUnmount(() => adapter?.dispose());
defineExpose({ getSource: () => adapter?.getSource() ?? props.source });
</script>
<template><div class="mark-editor" ref="root" /></template>
