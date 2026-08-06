# Zero-Mem vs production compaction

- Created: 2026-08-06T08:02:08.619Z
- Suite: standard
- Repetitions: 1
- Semantic model: Xenova/bge-m3+Xenova/bert-base-NER:q8:cpu
- Semantic model load: 3,112 ms
- Retrieval budget: 5 total traces, with up to 3 closure additions
- Context window: 24,000
- Zero-Mem uses the production compacted context size as its per-run maximum evidence-token budget.
- Accuracy uses semantic probe grading; evaluator-attribution eligibility is reported by the underlying compact bundle but is not used as the experimental score.

## Summary

| Model | Full | Compact | Zero-Mem | Compact context | Zero context | Context reduction | Compact memory tokens | Zero memory tokens | Compact memory time | Zero index + retrieval | Evidence coverage | ID recall | Calibrations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9router/cmc/deepseek/deepseek-v4-flash | 11/12 | 11/12 | 8/12 | 5,967 | 229 | 96.2% | 9,736 | 0 | 30,294 ms | 28,310 ms | 12/12 | 91.7% | 4/12 |

## Reader Prompt Cost

| Model | Full prompt/query | Compact prompt/query | Zero prompt/query | Zero vs compact |
| --- | ---: | ---: | ---: | ---: |
| 9router/cmc/deepseek/deepseek-v4-flash | 11,893 | 10,865 | 6,708 | 38.3% |

## Probe Diagnostics

| Model | Rep | Probe | Full | Compact | Zero-Mem | Evidence | Context / budget | Calibration | Retrieval |
| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | runtime-constraint | PASS: Node.js 20 | PASS: Node.js 20 or newer. | PASS: Node.js 20 or newer | 2/2 | 253 / 5,967 | supported | 137 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | public-api-constraint | PASS: Do not change the public query() function signature. | PASS: Do not change the public query() function signature. | PASS: the public query() function signature must remain unchanged | 2/2 | 253 / 5,967 | supported | 47 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | accepted-decision | PASS: workspaceHash:modelId:v3 | PASS: workspaceHash:modelId:v3 | FAIL: (empty) | 2/2 | 245 / 5,967 | unchanged (changed) | 58 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | rejected-decision | PASS: Redis; rejected because the benchmark must work offline and without a service dependency. | PASS: Redis was rejected because the benchmark must work offline and without a service dependency. | FAIL: without a service dependency. | 2/2 | 245 / 5,967 | list-pruned (changed) | 69 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | open-thread | PASS: The open verification issue is the Windows CRLF fixture, which still fails and must remain an open t | PASS: The Windows CRLF fixture still fails and remains an open thread until verified. | FAIL: (empty) | 2/2 | 239 / 5,967 | unchanged (changed) | 138 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | current-region-update | PASS: eu-west-1 | PASS: eu-west-1 | PASS: eu-west-1 | 2/2 | 116 / 5,967 | supported | 42 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | package-manager-correction | PASS: pnpm 9 | PASS: pnpm 9 | PASS: pnpm 9 | 2/2 | 108 / 5,967 | supported | 36 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | first-passing-day | PASS: Wednesday | PASS: Wednesday | PASS: Wednesday | 1/3 | 646 / 5,967 | supported | 41 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | current-patch-state | FAIL: No, the adapter patch is not active. The Thursday event — reversion after a separate regression — de | FAIL: No, the adapter patch is not active now; the Thursday reversion is the latest event determining that | FAIL: not active | 2/2 | 177 / 5,967 | unique-candidate (changed) | 62 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | unit-conversion-reasoning | PASS: The adapter divides by 1000 to convert the source unit (milliseconds, as returned by the upstream AP | PASS: The adapter divides by 1000 to convert duration values from milliseconds (the upstream API source un | PASS: The adapter divides duration values by 1000 to convert from milliseconds to seconds, because the ups | 3/3 | 200 / 5,967 | unchanged | 71 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | missing-secret-abstention | PASS: The staging database password is not recorded in this history — unknown. | PASS: The staging database password is unknown or not recorded in the history. | PASS: Unknown or not recorded — no admissible historical trace contains a staging database password, and c | 0/0 | 57 / 5,967 | supported | 56 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | semantic-alias-recall | PASS: crimson | PASS: crimson | PASS: crimson | 2/2 | 210 / 5,967 | supported | 29 ms |
