<script setup lang="ts">
import { ref } from 'vue';
defineProps<{ endpoint: string; sessionId?: string }>();
const open = ref(false);
</script>
<template><button class="ripple-dsh-toggle" @click="open = !open" :aria-expanded="open">◠ Ripple Knowledge</button><section v-if="open" class="ripple-dsh-panel" role="dialog" aria-label="Ripple Knowledge Workspace"><button class="ripple-dsh-close" @click="open = false" aria-label="关闭知识工作台">×</button><iframe v-if="sessionId" :key="sessionId" :src="`${endpoint}/?harness=${encodeURIComponent(sessionId)}`" title="Ripple 知识工作台"/><p v-else>先选择一个 DSH 会话，再打开知识工作台。</p></section></template>
