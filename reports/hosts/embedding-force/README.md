# Embedding entry and force graph verification

Verified locally on 2026-09-13.

## Delivered behavior

- Web and Electron expose a persistent sidebar entry for semantic settings. The form configures Ripple/WeMM or OpenAI-compatible text endpoints, probes with fixed public text, detects vector dimensions and activates the connection only after validation.
- Indexing is explicit, reports completed documents and vector units, supports cancellation/retry and reuses unchanged vectors. Failed replacement retains the previous working index. API keys are excluded from exposed state and caches.
- Browser HTTP fetch is bound to its global receiver; this fixed an actual runtime failure that Node tests alone did not catch. The Web CSP permits configured HTTPS and loopback endpoints. The bundled WeMM server allows only configured UI origins via CORS.
- Graph nodes are small dots with plain labels beneath. Repulsion, link attraction and label collision forces respond to dragging, cool down and save the settled layout. Edge weights are hidden until hover or keyboard focus. Pointer-captured consecutive taps correctly perform double-click exploration.

## Actual runtime evidence

- Real local WeMM `tencent/WeMM-Embedding-2B`, fixed revision `bbd6cd4bf52cfc6716f752a2df80b2706720bd95`, MPS, 2048 dimensions.
- Three authored test notes imported through the real browser folder picker. Connection test succeeded; three documents / three vectors indexed.
- `任务调度` and `削峰处理`, with no links or title mentions, acquired a semantic relation scored 78/100. Evidence view displayed both valid source passages. The unrelated coffee note did not appear at the default Lens threshold.
- The in-app browser also connected successfully and displayed this semantic edge after the fetch fix. The earlier direct navigation error was not the cause of the application fetch failure.
- Independent Chrome test verified node drag, default-hidden edge weight, focus-revealed weight and source evidence. Eight-node graph checked at 1667 × 1249; double-click into Async-Await and Back restored Promise. Mobile panel and controls were captured at 390 × 844; no claim of exhaustive mobile graph QA.
- Electron's actual renderer form crossed preload/IPC/worker boundaries, connected to the same real model and indexed all three test documents.

Screenshots: [Web index](web-index.png), [desktop index](desktop-index.png), [eight-node graph](graph.png).

## Automated checks and limits

- 90 tests passed, including real local HTTP connection, semantic evidence publication, vector reuse, failed replacement, cancellation, browser fetch receiver binding and force invariants.
- TypeScript, Vue typecheck, Web and desktop builds passed. Public artifact audit found zero embedded demo documents.
- Compatible API behavior was tested against a local protocol fixture, not a paid cloud account.
- Browser notes, connection and vectors remain page-local and are lost on refresh. Desktop vector cache is persistent; reconnecting the same model reuses it. Keys are session-only.
- The form currently indexes text. Multimodal configuration remains available through the pre-existing file-based adapter path.
- This is a bounded one-hop graph with a maximum of 40 visible relations, not a whole-vault graph.
