# Compact evaluation suite

- Created: 2026-09-15T14:16:02.965Z
- Suite: smoke
- Context window: 24,000
- Repetitions: 1
- Reader output cap: 1,024 tokens
- No-history leakage arm: disabled
- Checkpoint output cap: production default
- Compaction effort: production default
- Compaction model: same as probe model
- Pricing table: book-local-2026-08-27

## Evaluator Controls

| Model | Reducer | Rep | Date | Seed | Runtime | Fixture | Fixture capture |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| 9router/ag/gemini-3.8-flash-high | 9router/ag/gemini-3.8-flash-high | 1 | 2026-09-15 | 384b4825-7dbb-45 | git:8db80381ae84 | f064941b556c83e7 | captured |
| 9router/cmc/deepseek/deepseek-v4-flash | 9router/cmc/deepseek/deepseek-v4-flash | 1 | 2026-09-15 | 8158bafe-bc12-46 | git:8db80381ae84 | f064941b556c83e7 | captured |

## Model Summary

| Model | Accuracy full | Accuracy compact | Retention | Regressions | Improvements | Prompt savings | Net token savings | Net cost savings | Break-even tokens | Break-even cost | Avg compact tokens | Protocol full/compact |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9router/ag/gemini-3.8-flash-high | 0/5 | 0/5 | 0/0 | 0 | 0 | -6.9% | -44.4% | n/a | n/a | n/a | 17,579 | 5/5 |
| 9router/cmc/deepseek/deepseek-v4-flash | 0/5 | 0/5 | 0/0 | 0 | 0 | 3.2% | -11.5% | n/a | 27 | n/a | 4,964 | 5/5 |

## Category Summary

| Category | Full | Compact | Retention | Regressions | Improvements | Protocol full/compact | No-history passes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| static-recall | 0/10 | 0/10 | 0/0 | 0 | 0 | 10/10 | — |

## Run Details

| Model | Reducer | Rep | Compact | Attribution | Pre → post | Compression | Output cap | Checkpoint | Calls | Tokens | Time | Cost |
| --- | --- | ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 9router/ag/gemini-3.8-flash-high | 9router/ag/gemini-3.8-flash-high | 1 | compacted | INELIGIBLE:cost_unknown | 7,993 → 8,003 | 100.1% | default | 2,491 | 2 | 17,579 | 84,303 ms | pricing unknown |
| 9router/cmc/deepseek/deepseek-v4-flash | 9router/cmc/deepseek/deepseek-v4-flash | 1 | compacted degraded | INELIGIBLE:cost_unknown | 7,993 → 7,259 | 90.8% | default | 1,747 | 1 | 4,964 | 14,048 ms | pricing unknown |

## Probe Diagnostics

| Model | Rep | Probe | Category | Evidence | Comparison | Full | Compact | No history |
| --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| 9router/ag/gemini-3.8-flash-high | 1 | runtime-constraint | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:accounting_partial:provider_attempt_usage,cost_unknown,model_identity_unverified,comparison_model_identity_mismatch | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/ag/gemini-3.8-flash-high | 1 | public-api-constraint | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/ag/gemini-3.8-flash-high | 1 | accepted-decision | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/ag/gemini-3.8-flash-high | 1 | rejected-decision | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/ag/gemini-3.8-flash-high | 1 | open-thread | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | runtime-constraint | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | public-api-constraint | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | accepted-decision | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | rejected-decision | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
| 9router/cmc/deepseek/deepseek-v4-flash | 1 | open-thread | static-recall | early | INELIGIBLE:arm_1_ineligible:cost_unknown,arm_2_ineligible:cost_unknown | FAIL:ineligible-evidence | FAIL:ineligible-evidence | — |
