<script setup lang="ts">
defineProps<{ canOpen: boolean; browserLocal?: boolean; error?: string }>();
const emit = defineEmits<{ open: [] }>();
</script>
<template>
  <main class="ripple-welcome" aria-labelledby="welcome-title">
    <div class="welcome-lockup">
      <div class="welcome-art" aria-hidden="true"><img :src="'./brand/ripple-welcome-reference.png'" alt="" fetchpriority="high" draggable="false"/></div>
      <h1 id="welcome-title" class="welcome-wordmark">Ripple</h1>
      <div class="welcome-tagline"><div>Start from what you know.</div><div>Explore what connects.</div></div>
    </div>
    <div class="welcome-actions">
      <button v-if="canOpen" class="welcome-open" @click="emit('open')">打开知识目录</button>
      <p v-if="browserLocal" class="welcome-local">Markdown 文件仅在当前浏览器中处理</p>
      <p v-if="error" class="welcome-error" role="alert">{{ error }}</p>
    </div>
  </main>
</template>
<style>
.ripple-welcome{min-height:100svh;width:100%;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px 20px 28px;background:#fff;color:#0b1d35;overflow:auto;color-scheme:light}
.welcome-lockup{width:min(100%,calc((100svh - 180px)*1.08),1254px);container-type:inline-size;text-align:center;flex:none}
.welcome-art{width:100%;aspect-ratio:1254 / 750;overflow:hidden;user-select:none}
.welcome-art img{display:block;width:100%;height:auto;max-width:none}
.welcome-wordmark{font-family:'Avenir Next',Avenir,'Helvetica Neue',sans-serif;font-weight:500;font-size:18.1cqw;line-height:1.12;letter-spacing:.025em;margin:0 0 3cqw;padding-left:.025em;color:#0b1d35}
.welcome-tagline{font-family:'Avenir Next',Avenir,'Helvetica Neue',sans-serif;font-weight:400;font-size:2.85cqw;line-height:1.65;letter-spacing:.22em;padding-left:.22em;color:#718095;white-space:nowrap}
.welcome-actions{display:flex;flex-direction:column;align-items:center;gap:13px;margin-top:34px;max-width:100%;flex:none}
.welcome-open{display:inline-flex;align-items:center;justify-content:center;gap:22px;padding:13px 23px;border:1px solid #dce6f3;border-radius:14px;background:#f7faff;color:#425c81;font:500 14px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;transition:background .18s,border-color .18s}
.welcome-open:hover{background:#edf4fe;border-color:#b7cdef}.welcome-open:focus-visible{outline:3px solid #97baff;outline-offset:4px}.welcome-open span{font-size:18px}
.welcome-local{font-size:11px;color:#778399;letter-spacing:.04em;margin:0}.welcome-error{font-size:13px;color:#a13d3d;margin:0;text-align:center;max-width:440px}
@media(max-width:520px){.ripple-welcome{padding:24px 12px}.welcome-lockup{width:100%;max-width:480px}.welcome-tagline{font-size:clamp(12px,3.3cqw,16px);letter-spacing:.12em}.welcome-actions{margin-top:40px}.welcome-open{padding:13px 21px}}
@media(max-height:560px) and (min-width:521px){.welcome-lockup{width:420px}.ripple-welcome{justify-content:flex-start}.welcome-actions{margin-top:20px}}
@media(prefers-reduced-motion:reduce){.welcome-open{transition:none}}
</style>
