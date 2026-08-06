# Zero-Mem vs production compaction

- Created: 2026-08-06T06:16:43.169Z
- Suite: standard
- Repetitions: 1
- Retrieval budget: top-5 + 3 closure traces
- Context window: 24,000
- Accuracy uses semantic probe grading; evaluator-attribution eligibility is reported by the underlying compact bundle but is not used as the experimental score.

## Summary

| Model | Full | Compact | Zero-Mem | Compact context | Zero context | Context reduction | Compact memory tokens | Zero memory tokens | Compact memory time | Zero index + retrieval | Evidence coverage | ID recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9router/cudem/deepseek-v4-flash | 10/11 | 5/11 | 9/11 | 4,927 | 436 | 91.1% | 11,071 | 0 | 107,256 ms | 209 ms | 11/11 | 81.8% |

## Reader Prompt Cost

| Model | Full prompt/query | Compact prompt/query | Zero prompt/query | Zero vs compact |
| --- | ---: | ---: | ---: | ---: |
| 9router/cudem/deepseek-v4-flash | 13,487 | 11,678 | 8,310 | 28.8% |

## Probe Diagnostics

| Model | Rep | Probe | Full | Compact | Zero-Mem | Evidence | Context | Retrieval |
| --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: |
| 9router/cudem/deepseek-v4-flash | 1 | runtime-constraint | PASS: Node.js 20 or newer | PASS: Node.js 20 or newer is required. | PASS: Node.js 20 or newer. | 1/2 | 514 | 33 ms |
| 9router/cudem/deepseek-v4-flash | 1 | public-api-constraint | PASS: Do not change the public query() function signature. | FAIL: No constraint stating that a public API must not change was recorded in this conversation. | PASS: The public query() function signature must not change. The exact recorded constraint is: "Do not cha | 1/2 | 503 | 17 ms |
| 9router/cudem/deepseek-v4-flash | 1 | accepted-decision | PASS: workspaceHash:modelId:v3 | FAIL: No cache-key format was accepted or established in the record. The conversation contains no cache-ke | PASS: workspaceHash:modelId:v3 | 2/2 | 595 | 17 ms |
| 9router/cudem/deepseek-v4-flash | 1 | rejected-decision | PASS: Redis was rejected because the benchmark must work offline and without a service dependency. | FAIL: No proposed dependency appears in the record. The only rejection was the maintainer's rejection of t | PASS: Redis was rejected because the benchmark must work offline and without a service dependency. | 2/2 | 631 | 12 ms |
| 9router/cudem/deepseek-v4-flash | 1 | open-thread | PASS: The Windows CRLF fixture still fails and must remain an open thread until verified. | FAIL: (empty) | FAIL: (empty) | 2/2 | 328 | 14 ms |
| 9router/cudem/deepseek-v4-flash | 1 | current-region-update | PASS: eu-west-1 | FAIL: No staging deployment region exists in the established record; this value was never referenced. | PASS: eu-west-1 | 2/3 | 490 | 29 ms |
| 9router/cudem/deepseek-v4-flash | 1 | package-manager-correction | PASS: pnpm 9 | FAIL: (empty) | PASS: pnpm 9 | 1/3 | 488 | 18 ms |
| 9router/cudem/deepseek-v4-flash | 1 | first-passing-day | PASS: Wednesday | PASS: Wednesday | PASS: Wednesday | 3/3 | 432 | 15 ms |
| 9router/cudem/deepseek-v4-flash | 1 | current-patch-state | FAIL: No. The Thursday verification event states the adapter patch was reverted after a separate regressio | PASS: No, the adapter patch is not active. The latest determining event is the Thursday verification event | FAIL: No — the adapter patch is not active now. The latest event determining that state is the Thursday re | 3/3 | 467 | 26 ms |
| 9router/cudem/deepseek-v4-flash | 1 | unit-conversion-reasoning | PASS: The adapter divides by 1000 because the upstream API returns durations in milliseconds (source unit) | PASS: The adapter divides by 1000 to convert duration values from the API's source unit, milliseconds, to  | PASS: Because the upstream API returns duration values in milliseconds, while the database persists them i | 3/3 | 288 | 15 ms |
| 9router/cudem/deepseek-v4-flash | 1 | missing-secret-abstention | PASS: unknown or not recorded | PASS: unknown or not recorded | PASS: The staging database password is not recorded in the available history. | 0/0 | 61 | 1 ms |
