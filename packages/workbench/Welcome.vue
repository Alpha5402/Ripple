<script setup lang="ts">
defineProps<{ canOpen: boolean; error?: string }>();
const emit = defineEmits<{ open: [] }>();
</script>
<template>
  <main class="ripple-welcome" aria-label="Ripple">
    <div class="welcome-lockup">
      <div class="welcome-art" aria-hidden="true"><img :src="'./brand/ripple-logo.png'" alt="" fetchpriority="high" draggable="false"/></div>
      <div class="welcome-tagline"><div>Start from what you know.</div><div>Explore what connects.</div></div>
    </div>
    <div class="welcome-actions">
      <button v-if="canOpen" class="welcome-open" @click="emit('open')">打开工作区</button>
      <p v-if="error" class="welcome-error" role="alert">{{ error }}</p>
    </div>
  </main>
</template>
<style>
.ripple-welcome{min-height:100svh;width:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 20px;background:#fff;color:#0b1d35;color-scheme:light}
.welcome-lockup{width:min(100%,480px);text-align:center;flex:none}
.welcome-art{width:min(100%,380px,52svh);aspect-ratio:1;margin:0 auto 24px;user-select:none}
.welcome-art img{display:block;width:100%;height:100%;object-fit:contain}
.welcome-tagline{font-family:'Avenir Next',Avenir,'Helvetica Neue',sans-serif;font-weight:400;font-size:16px;line-height:1.8;letter-spacing:.14em;padding-left:.14em;color:#718095}
.welcome-actions{display:flex;flex-direction:column;align-items:center;gap:13px;margin-top:32px;max-width:100%;flex:none}
.welcome-open{display:inline-flex;align-items:center;justify-content:center;padding:13px 25px;border:1px solid #dce6f3;border-radius:14px;background:#f7faff;color:#425c81;font:500 14px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;transition:background .18s,border-color .18s}
.welcome-open:hover{background:#edf4fe;border-color:#b7cdef}.welcome-open:focus-visible{outline:3px solid #97baff;outline-offset:4px}
.welcome-error{font-size:13px;color:#a13d3d;margin:0;text-align:center;max-width:440px}
@media(max-width:520px){.welcome-art{width:min(80%,300px,46svh)}.welcome-tagline{font-size:14px;letter-spacing:.1em}}
@media(prefers-reduced-motion:reduce){.welcome-open{transition:none}}
</style>
