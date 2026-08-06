# Zero-Mem retrieval-only evaluation

- Created: 2026-08-06T04:55:11.551Z
- Suite: standard
- History: 72 messages / 7,940 estimated tokens
- Retrieval budget: top-5 + 3 closure traces
- Index time: 10 ms
- Average retrieval time: 13.2 ms/query
- Provider-backed reader comparison was not run because no API credentials are configured.
- Full-history evidence recall is a reference upper bound, not an answer-quality score.

## Retrieval Summary

| Arm | Expectation coverage | Exact source-ID recall | Avg context tokens | Context reduction | Memory-operation LLM tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full history (reference) | 11/11 | 100.0% | 7,940 | 0.0% | n/a |
| Zero-Mem | 11/11 | 81.8% | 436 | 94.5% | 0 |

## Probe Diagnostics

| Probe | Category | Coverage | ID hits | Expected | Retrieved | Context tokens | Retrieval |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| runtime-constraint | static-recall | PASS | 1 | 2 | 8 | 514 | 24 ms |
| public-api-constraint | static-recall | PASS | 1 | 2 | 8 | 503 | 11 ms |
| accepted-decision | static-recall | PASS | 2 | 2 | 7 | 595 | 14 ms |
| rejected-decision | static-recall | PASS | 2 | 2 | 8 | 631 | 12 ms |
| open-thread | static-recall | PASS | 2 | 2 | 8 | 328 | 11 ms |
| current-region-update | knowledge-update | PASS | 2 | 3 | 8 | 490 | 13 ms |
| package-manager-correction | conflict-resolution | PASS | 1 | 3 | 8 | 488 | 17 ms |
| first-passing-day | temporal-reasoning | PASS | 3 | 3 | 8 | 432 | 11 ms |
| current-patch-state | temporal-reasoning | PASS | 3 | 3 | 8 | 467 | 20 ms |
| unit-conversion-reasoning | multi-hop | PASS | 3 | 3 | 8 | 288 | 11 ms |
| missing-secret-abstention | abstention | PASS | 0 | 0 | 0 | 61 | 1 ms |

To run the answer-quality comparison after configuring a provider:

```text
npm run eval:zero-mem -- --suite standard --model <provider/model>
```
