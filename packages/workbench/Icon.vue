<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  sidebar: 'M4 4h16v16H4z M9 4v16 M6 8h1 M6 12h1',
  search: 'M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13z M15.5 15.5L21 21',
  back: 'M14 6l-6 6 6 6',
  book: 'M12 6c-3-2-6-2-9-1v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1z M12 6v14',
  graph: 'M12 9V5 M9 14l-4 3 M15 14l4 3 M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M12 5a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M3 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z M21 21a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  folder: 'M3 6h7l2 2h9v12H3z M3 6V4h7l2 2',
  note: 'M6 3h9l4 4v14H6z M15 3v5h4 M9 12h7 M9 16h5',
  edit: 'M15 4l5 5 M4 20l5-1L21 7l-5-5L4 14z',
  arrow: 'M5 12h14 M14 7l5 5-5 5',
  close: 'M6 6l12 12 M6 18L18 6',
  refresh: 'M20 10a8 8 0 1 0-2 8 M20 4v6h-6',
  check: 'M5 12l4 4L19 6',
  sparkle: 'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3z',
  evidence: 'M8 3H5v18h14V3h-3 M8 2h8v4H8z M8 10h8 M8 14h8 M8 18h5',
  more: 'M5 12h.1 M12 12h.1 M19 12h.1',
};
</script>
<template><svg :width="size ?? 18" :height="size ?? 18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] ?? paths.note" /></svg></template>
