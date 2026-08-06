# Zero-Mem vs production compaction

- Created: 2026-08-06T08:47:03.290Z
- Suite: standard
- Repetitions: 1
- Semantic model: Xenova/bge-m3+Xenova/bert-base-NER:q8:cpu
- Semantic model load: 6,341 ms
- Retrieval budget: 5 total traces, with up to 3 closure additions
- Context window: 24,000
- Reader output cap: 1,024 tokens
- Zero-Mem uses the production compacted context size as its per-run maximum evidence-token budget.
- Accuracy uses semantic probe grading; evaluator-attribution eligibility is reported by the underlying compact bundle but is not used as the experimental score.

## Summary

| Model | Full | Compact | Zero-Mem | Compact context | Zero context | Context reduction | Compact memory tokens | Zero memory tokens | Compact memory time | Zero index + retrieval | Evidence coverage | ID recall | Calibrations |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9router/cmc/deepseek/deepseek-v4-flash | 11/12 | 7/12 | 12/12 | 4,972 | 229 | 95.4% | 11,016 | 0 | 50,581 ms | 162,730 ms | 12/12 | 91.7% | 0/12 |

## Reader Prompt Cost

| Model | Full prompt/query | Compact prompt/query | Zero prompt/query | Zero vs compact |
| --- | ---: | ---: | ---: | ---: |
| 9router/cmc/deepseek/deepseek-v4-flash | 11,893 | 9,895 | 6,708 | 32.2% |

## Probe Diagnostics

| Model | Rep | Probe | Full | Compact | Zero-Mem | Evidence | Context / budget | Calibration | Retrieval |
| --- | ---: | --- | --- | --- | --- | ---: | ---: | --- | ---: |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | runtime-constraint | PASS: Node.js 20 or newer | PASS: Node.js 20+ | PASS: Node.js 20 or newer | 2/2 | 253 / 4,972 | supported | 78 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | public-api-constraint | PASS: The query() function signature must not change — "Do not change the public query() function signatur | FAIL: No constraint about a public API that must not change was recorded in this conversation. The only AP | PASS: The public API that must not change is the query() function. The exact recorded constraint is: "the  | 2/2 | 253 / 4,972 | unchanged | 120 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | accepted-decision | PASS: workspaceHash:modelId:v3 | FAIL: No cache-key format was accepted in the available record; I will not invent one. | PASS: workspaceHash:modelId:v3 | 2/2 | 245 / 4,972 | supported | 144 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | rejected-decision | PASS: Redis was rejected because the benchmark must work offline and without a service dependency. | FAIL: npm was rejected as the package manager; the correction stated the repository requires pnpm 9 and th | PASS: Redis was rejected because the benchmark must work offline and without a service dependency. | 2/2 | 245 / 4,972 | unchanged | 120 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | open-thread | FAIL: Windows CRLF fixture | FAIL: No fixture name exists in the established record; the open verification item is that the adapter pat | PASS: The Windows CRLF fixture still fails and remains an open thread until verified. | 2/2 | 239 / 4,972 | unchanged | 50 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | current-region-update | PASS: eu-west-1 | FAIL: unknown | PASS: eu-west-1 | 2/2 | 116 / 4,972 | supported | 59 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | package-manager-correction | PASS: pnpm 9 | PASS: pnpm 9 | PASS: pnpm 9 | 2/2 | 108 / 4,972 | supported | 106 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | first-passing-day | PASS: Wednesday | PASS: Wednesday | PASS: Wednesday | 1/3 | 646 / 4,972 | supported | 79 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | current-patch-state | PASS: No, the adapter patch is not active. The latest determining event was the Thursday verification entr | PASS: The adapter patch is not active now; the deciding event is the Thursday verification event stating i | PASS: No, the adapter patch is not active now. The latest event determining that state is the Thursday ver | 2/2 | 177 / 4,972 | supported | 138 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | unit-conversion-reasoning | PASS: The adapter divides by 1000 to convert the upstream API's milliseconds to the database's whole secon | PASS: The adapter divides duration values by 1000 to convert from milliseconds, the unit returned by the u | PASS: The adapter divides by 1000 to convert duration values from milliseconds (the unit returned by the u | 3/3 | 200 / 4,972 | unchanged | 69 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | missing-secret-abstention | PASS: Not recorded in the conversation history. | PASS: unknown | PASS: The staging database password is not recorded in the available history; it is unknown, and credentia | 0/0 | 57 / 4,972 | supported | 45 ms |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | semantic-alias-recall | PASS: crimson | PASS: crimson | PASS: crimson | 2/2 | 210 / 4,972 | supported | 61 ms |
