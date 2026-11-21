# Context workspace verification and release evidence

- Date: 2026-11-21 21:51 IST (system clock)
- Version: 0.35.0
- Base: acd5e42, original checkout left unchanged
- Scope: context preparation/receipts, memory-only diagnostics, attachment choices, recorded task relationships, integrated UI

## Automated checks

- `npm test`: 64 files passed, 680 tests passed, 14.91 seconds. This run follows the final functional changes through the compact control targets and lineage extraction fixture.
- `npm run typecheck`: passed for client and server.
- `git diff --check`: passed.
- `npm pack --dry-run --json`: package includes CREDITS.md and all four grammar LICENSE files; no new runtime dependency. Package version and lockfile root version both 0.35.0.

Tests were observed failing before the initial Unicode implementation, the oversized pack correction, completed-child precedence, and independent identity enrichment. Existing picker-layout tests failed when Overview was added, then were updated to assert both full and overview choices. New text/helper and integration checks for some later behaviors were added after implementation; they passed but do not constitute red-before-green evidence for every acceptance criterion. No blanket claim of exhaustive behavioral proof is made.

## Local runtime

Paseo 0.16.2 loaded and reloaded the plugin successfully from the feature worktree in a separate temporary home. Listen address: 127.0.0.1:16847; relay disabled. Its Contextualise knowledge port was changed to 16848 after the default port conflicted with another process. No settings in the everyday daemon were changed.

The test index used this public project and an explicitly labeled synthetic task, not private conversation data. Browser interactions exercised Overview, Full project, selected search/add, prepared preview, recording, and a synthetic delegated task reader. Actual app frames at 1000, 390 and 320 CSS pixels had no root horizontal overflow; the 320px check found no visible action button outside the viewport. Compact controls were changed to 44px height after inspecting the narrow render.

Screenshot capture was attempted after focusing the tab, but the browser tool refused it because the Review tab was not visible. Therefore no screenshot-based visual, light/dark contrast, native screen-reader or physical-device pass is claimed. These checks remain limitations. DOM/text inspection is not equivalent to a visual design certification.

Clipboard was invoked with success/error feedback wired through the existing host helper; the transient toast was not independently captured. The prepared-text reader showed the actual first-line grant and matching size metadata.

## Local overhead trial

Node 24.22.1, macOS, synthetic in-process calls, 1,000 observations per run, five runs per payload/recording condition, no network/disk in observation. No separate warm-up; variance shown as median and slowest run. The no-op work function returned a fixed ASCII payload; this does not model provider latency or realistic result diversity.

| Payload | Recording | Median ms/call | Slowest run ms/call |
| --- | --- | --- | --- |
| 1 KiB | off | 0.000659 | 0.000777 |
| 1 KiB | on | 0.031726 | 0.066787 |
| 64 KiB | off | 0.000130 | 0.000174 |
| 64 KiB | on | 0.070975 | 0.072875 |

The 64 KiB recording-on median is below the proposed 2 ms/call local threshold. This is not a production latency commitment or token-savings claim.

## Independent reviews and fixes

Backend review found three material defects, independently confirmed by fresh source readers:

1. Empty results lacked semantic classification. Fixed at result producers with out-of-band weak metadata; model-facing result text is unchanged. Knowledge empty-search integration test added.
2. Parent readers did not find recorded children. Fixed with bounded task-store lookup over explicit parent facts and bidirectional integration coverage.
3. A losing status snapshot discarded newly learned identity. Fixed by merging monotonic identity independently of status, with pure merge and durable-log assertions. Imported observation times now captured before reading.

UI review found four material defects:

1. Stopped cached events could outlive visible expiry. Fixed with expiry filtering/timer and polling while retained rows remain.
2. Refresh could label old index content current. Fixed with invalidation, bounded refresh and result-derived freshness; integration test edits a document before preparation.
3. Parent/child navigation recursively nested readers. Fixed by one current target and one reader.
4. Unresolved native observations could overlap recorded tasks. Fixed by separate headings, explicit overlap warning, no combined exact child count and no guessed navigation.

The UI reviewer re-read the fixes and scored all four resolved at source scope. This is not an independent runtime or screenshot pass. Backend fix-list verification scored child navigation, identity preservation and import observation-time fixes resolved; it found three remaining empty-result paths (boundary browse and attached load/read), which were then marked at their producers and included in the final passing suite. Those final three markings were not independently re-checked. No full second review was performed.

Additional rendered-DOM checks exercised actual app frames at 390 and 320 CSS pixels, including dark theme. Root overflow was false and visible action buttons remained inside the 320px frame. After reloading the changed controls, Copy and Start recording measured 44px high. Sampled dark-theme foreground values were rgb(250,250,250) and muted rgb(161,165,164), over the nearest opaque rgb(24,27,26) surface. This is sampled computed-style evidence, not an exhaustive contrast audit. The separate native-observation section was verified in the synthetic task reader.

## Distribution and limitations

Paseo Context and dsh-context are credited as inspiration. No upstream code, UI assets, screenshots or native log parser was copied into this implementation, so no new upstream Apache license text is represented as applying to original Contextualise code. Existing grammar licenses remain included. CREDITS.md ships in the package.

Diagnostics report plugin preparation/configuration/returned outputs, not provider acknowledgement. Counts cover retained observations, not bills or verified savings. Task facts reflect recorded data; unresolved native references can overlap known tasks and are labeled accordingly. New optional task fields remain readable by this version; older writers may drop them.

Publication and reinstall statuses must be reported from actual command results, not inferred from this file. The everyday/live installation remains untouched; only the isolated test home was installed/reloaded.
