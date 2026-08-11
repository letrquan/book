# Zero-Mem vs production compaction

- Created: 2026-08-06T06:24:47.578Z
- Suite: standard
- Repetitions: 1
- Retrieval budget: top-5 + 3 closure traces
- Context window: 24,000
- Accuracy uses semantic probe grading; evaluator-attribution eligibility is reported by the underlying compact bundle but is not used as the experimental score.

## Summary

| Model | Full | Compact | Zero-Mem | Compact context | Zero context | Context reduction | Compact memory tokens | Zero memory tokens | Compact memory time | Zero index + retrieval | Evidence coverage | ID recall |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9router/cudem/deepseek-v4-flash | 11/11 | 5/11 | 10/11 | 4,927 | 436 | 91.1% | 15,016 | 0 | 46,569 ms | 357 ms | 11/11 | 81.8% |

## Reader Prompt Cost

| Model | Full prompt/query | Compact prompt/query | Zero prompt/query | Zero vs compact |
| --- | ---: | ---: | ---: | ---: |
| 9router/cudem/deepseek-v4-flash | 13,865 | 11,867 | 7,932 | 33.2% |

## Probe Diagnostics

| Model | Rep | Probe | Full | Compact | Zero-Mem | Evidence | Context | Retrieval |
| --- | ---: | --- | --- | --- | --- | ---: | ---: | ---: |
| 9router/cudem/deepseek-v4-flash | 1 | runtime-constraint | PASS: Node.js 20 or newer | PASS: Node.js 20 or newer is required. | PASS: Node.js 20 (recorded as: "The runtime must remain Node.js 20 or newer"). | 1/2 | 514 | 40 ms |
| 9router/cudem/deepseek-v4-flash | 1 | public-api-constraint | PASS: The public query() function signature must not change. | FAIL: No such constraint was recorded. The established record contains no requirement about a public API t | PASS: Do not change the public query() function signature. | 1/2 | 503 | 29 ms |
| 9router/cudem/deepseek-v4-flash | 1 | accepted-decision | PASS: workspaceHash:modelId:v3 | FAIL: No exact cache-key format was accepted or established in the record; the conversation contains no su | PASS: workspaceHash:modelId:v3 | 2/2 | 595 | 26 ms |
| 9router/cudem/deepseek-v4-flash | 1 | rejected-decision | PASS: Redis was rejected because the benchmark must work offline and without a service dependency. | FAIL: No proposed dependency was rejected in the established record; the handoff contains no mention of an | PASS: Redis was rejected as the proposed cache service, because the benchmark must work offline and withou | 2/2 | 631 | 22 ms |
| 9router/cudem/deepseek-v4-flash | 1 | open-thread | PASS: The Windows CRLF fixture still fails and must remain an open thread until verified. | FAIL: (empty) | FAIL: (empty) | 2/2 | 328 | 20 ms |
| 9router/cudem/deepseek-v4-flash | 1 | current-region-update | PASS: eu-west-1 | FAIL: unknown — no staging deployment region was recorded in the handoff. | PASS: eu-west-1 | 2/3 | 490 | 40 ms |
| 9router/cudem/deepseek-v4-flash | 1 | package-manager-correction | PASS: pnpm 9 | PASS: pnpm 9 | PASS: {"answer":"pnpm 9"} {"answer":"pnpm 9"} | 1/3 | 488 | 43 ms |
| 9router/cudem/deepseek-v4-flash | 1 | first-passing-day | PASS: Wednesday | PASS: Wednesday | PASS: Wednesday | 3/3 | 432 | 40 ms |
| 9router/cudem/deepseek-v4-flash | 1 | current-patch-state | PASS: No — the adapter patch was reverted on Thursday and is not active now. That revert is the latest eve | PASS: No, the adapter patch is not active now. The latest determining event is Thursday, when it was rever | PASS: No, the adapter patch is not active now. The latest event that determines that state is the Thursday | 3/3 | 467 | 51 ms |
| 9router/cudem/deepseek-v4-flash | 1 | unit-conversion-reasoning | PASS: The adapter divides by 1000 to convert the upstream API's duration unit (milliseconds) to the databa | FAIL: To convert milliseconds to seconds, since the API uses milliseconds and the database uses seconds. | PASS: The adapter divides by 1000 to convert duration values from the upstream API's milliseconds (source  | 3/3 | 288 | 24 ms |
| 9router/cudem/deepseek-v4-flash | 1 | missing-secret-abstention | PASS: Not recorded in the conversation history. | PASS: The staging database password is not recorded in this history. | PASS: unknown or not recorded | 0/0 | 61 | 2 ms |
