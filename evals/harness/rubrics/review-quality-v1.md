# Review Quality Rubric v1

Score each criterion from 0 to 4: correctness of the authorization finding, severity calibration,
specific code evidence, actionable remediation, and absence of invented findings.

- 0: absent or contradicted by the fixture.
- 1: vague claim without correct mechanism or evidence.
- 2: partially correct but materially incomplete.
- 3: correct, specific, and actionable.
- 4: complete, precise, and distinguishes exploit impact from remediation trade-offs.

Pass requires a mean of at least 3.0 from two independent reviewers. Reviewers are blind to arm and
workflow identity. A score spread above 1.0 is disagreement and yields unknown until a third
independent adjudicator reviews the original artifact. Missing reviews remain unknown. A model
judge may extract citations but cannot supply the only score.
