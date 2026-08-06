# Zero-Mem retrieval-only evaluation

- Created: 2026-08-06T07:33:09.158Z
- Suite: standard
- History: 74 messages / 7,985 estimated tokens
- Semantic model: Xenova/bge-m3+Xenova/bert-base-NER:q8:cpu
- Semantic model load: 4,199 ms
- Retrieval budget: 5 total traces, with up to 3 closure additions
- Index time: 174,609 ms
- Average retrieval time: 720.1 ms/query
- Provider-backed reader comparison was not run because no API credentials are configured.
- Full-history evidence recall is a reference upper bound, not an answer-quality score.

## Retrieval Summary

| Arm | Expectation coverage | Exact source-ID recall | Avg context tokens | Context reduction | Memory-operation LLM tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Full history (reference) | 12/12 | 100.0% | 7,985 | 0.0% | n/a |
| Zero-Mem | 10/12 | 68.0% | 297 | 96.3% | 0 |

## Probe Diagnostics

| Probe | Category | Coverage | ID hits | Expected | Retrieved | Context tokens | Retrieval |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| runtime-constraint | static-recall | PASS | 2 | 2 | 5 | 253 | 857 ms |
| public-api-constraint | static-recall | PASS | 2 | 2 | 5 | 253 | 656 ms |
| accepted-decision | static-recall | PASS | 2 | 2 | 5 | 245 | 892 ms |
| rejected-decision | static-recall | PASS | 2 | 2 | 5 | 245 | 658 ms |
| open-thread | static-recall | PASS | 2 | 2 | 5 | 239 | 571 ms |
| current-region-update | knowledge-update | FAIL | 0 | 2 | 4 | 480 | 693 ms |
| package-manager-correction | conflict-resolution | PASS | 1 | 2 | 4 | 622 | 878 ms |
| first-passing-day | temporal-reasoning | PASS | 1 | 3 | 5 | 646 | 746 ms |
| current-patch-state | temporal-reasoning | FAIL | 0 | 3 | 2 | 109 | 855 ms |
| unit-conversion-reasoning | multi-hop | PASS | 3 | 3 | 5 | 200 | 650 ms |
| missing-secret-abstention | abstention | PASS | 0 | 0 | 0 | 57 | 600 ms |
| semantic-alias-recall | static-recall | PASS | 2 | 2 | 5 | 210 | 585 ms |

To run the answer-quality comparison after configuring a provider:

```text
npm run eval:zero-mem -- --suite standard --model <provider/model>
```
