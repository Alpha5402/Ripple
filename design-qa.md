# Ripple welcome and brand QA

final result: passed

## Visual truth and captures

- Source: `apps/workbench/public/brand/ripple-welcome-reference.png`, original 1254 × 1254 pixels; logo: `apps/workbench/public/brand/ripple-logo.png`.
- Implementation: local preview `http://127.0.0.1:4321/`. Browser screenshots captured inline in the implementation task on 2026-09-13; no filesystem screenshot path was returned by the browser tool.
- Full-view comparison: `http://127.0.0.1:47326/`, served by the local QA helper. Source and implementation both occupy 1254 × 1254 CSS coordinate spaces, displayed at the same 0.45 scale. Mobile comparison is 390 × 844 CSS pixels. Density was normalized by equal CSS scaling rather than comparing unequal raster screenshots.
- State: fresh welcome, no selected directory; reference has no directory button, implementation adds the functional entry below its lockup.
- Final screenshot inspected after confirming the original illustration loaded (`complete: true`, natural width 1254). Typography and illustration inspected together; separate focused captures were unnecessary for the simple single-section composition.

## Findings and iteration

- Initial P2: mobile tagline became too small at proportional desktop sizing. Fixed with a 12px minimum and reduced letter spacing; final 390px view preserves two complete lines without overflow.
- Initial P2: desktop lockup cap reduced its scale excessively in a square viewport. Raised cap to 1254px; height allowance keeps the added directory button visible.
- Functional P2: changing directories while editing could discard a draft. Added existing unsaved-edit dialog before invoking the picker; browser interaction verified dialog and discard-to-picker flow.
- No remaining actionable P0/P1/P2 findings.

## Surface checks

- Typography: Avenir Next/Avenir with Helvetica Neue fallback, medium Ripple wordmark, lightweight spaced taglines. Title is an h1; each tagline is a selectable div. Their glyph shapes approximate the supplied raster rather than embedding raster text.
- Spacing: centered single lockup, preserved orbital composition, white background, responsive directory action below. Square and mobile full-view comparisons inspected.
- Colors: original blue orbital artwork and logo retained; navy heading and subdued blue-gray tagline match the visual direction. Interactive focus and hover are explicit.
- Assets: original supplied PNGs are unchanged. CSS clips the illustration above the raster lettering, following the user's explicit request to separate text. No generated approximation or vector replacement.
- Copy: exact reference English wording; no embedded demonstration notes in default Web/desktop output.

## Interaction and build evidence

- Browser directory picker imported 11 fixture Markdown notes into the real workbench; reading and editor opened.
- Unsaved source edit triggered protection when switching directories; discard continued to a functioning directory picker.
- Reload returned to the empty welcome page.
- New packaged desktop App launched with independent QA profile and exposed welcome title, taglines and directory action at `ripple://app/`.
- TypeScript and Vue checks passed; 85 tests passed outside the sandbox (sandbox watcher test lacked macOS filesystem events).
- Web and desktop builds passed. Public artifact audit: 73 files, zero embedded documents, private-field audit passed.
- Console inspection was not provided by the browser interface; runtime verification used actual interactions and rendered state. No claim of exhaustive browser or desktop acceptance.

## Follow-up polish

- P3: exact wordmark font is not supplied; platform font fallback can subtly change glyph widths.
- Native OS icon cache refresh and fresh-install behavior on other machines were not tested.
