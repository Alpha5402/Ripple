# Ripple R logo welcome update

final result: passed

User-selected source: `design/brand/ripple-logo-v3.png`, copied unchanged into `apps/workbench/public/brand/ripple-logo.png`.

The new welcome uses the complete R logo, two existing English taglines and one “打开工作区” action. Removed the oversized Ripple heading and browser Markdown notice as requested. Sidebar action uses the same wording.

Browser-rendered final screenshot inspected at the local preview `http://127.0.0.1:4321/` in the implementation task. The R silhouette, internal blue page/ripple and white spacing render clearly. No P0/P1/P2 findings. DOM confirms no visible Ripple heading or removed notice. Screenshot evidence is inline in the task; the browser did not return a saved file path.

Vue typecheck, Web and desktop builds and public artifact audit passed. This update changes presentation and assets; the existing folder import implementation is unchanged.

## Subsequent semantic settings and force graph update

User requested small dot nodes, plain labels below them, attraction/repulsion and hover-only edge weights. Actual eight-node browser capture inspected at 1667 × 1249: `reports/hosts/embedding-force/graph.png`. No label backgrounds, orbital decorations or permanent edge-score badges remain. Pointer drag, hover/focus weights, double-click exploration and Back were exercised. Force layout stops after cooling and honors reduced motion. Semantic form and real Web/Electron indexing evidence are recorded in `reports/hosts/embedding-force/README.md`. No actionable desktop P0/P1/P2 visual findings remained; mobile graph readability at every zoom level has not been exhaustively verified.
