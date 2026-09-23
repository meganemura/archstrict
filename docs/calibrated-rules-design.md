archstrict provides the built-in `config-meaning` assessment through `archstrict check --prove`. Jev chooses whether a rule's shape agrees with or contradicts its `because` text. A contradiction produces a finding when confidence reaches 0.7. A lower confidence produces an `undecided` result. A consistent choice produces no finding. This check is advisory and cannot enter todo. The general, user-authored `calibrated: [...]` array remains a design only. Neither `check` nor `rules <path>` reads that array. Adding it to a real config has no effect.

# Calibrated rules

archstrict reports the class of evidence for each result.
The report keeps the three tiers distinct.
This design adds an optional tier that uses Jev from TypeSafe AI.

| Tier | What the result establishes |
| --- | --- |
| Proven | Existing structural rules produce deterministic results that a consumer can replay. |
| Calibrated | A trained probability describes accuracy across many cases. It never guarantees correctness for one case. |
| Explored | An agent inspects the code and records the date. The result has no repeatability guarantee. |

This document defines only the calibrated tier.
The explored tier belongs to separate future work and stays outside this design.

Do not use a calibrated score to rank, annotate, or change the weight of a proven violation.
Such a score invites a consumer to discount a real violation.
The calibrated tier produces separate results with explicit labels and leaves deterministic results unchanged.

## 1. Config location

The new `calibrated` field contains an array of rule entries at the top level of the config.
It sits beside `edges` and `declaredModules`; it never sits inside `edges`.

Each entry has the shape `{ tags | glob, ask, criteria, at, because }`.
The `at` field is optional.
Each entry selects files with either `tags` or `glob`, never both.
These alternatives follow the existing approach to file selection through classification.

| Field | Purpose |
| --- | --- |
| `tags` | Select the files through their tags. |
| `glob` | Select the files through a path pattern. |
| `ask` | State the question that Jev assesses for each selected file. |
| `criteria` | State the criteria for that assessment. |
| `at` | Set the optional confidence threshold for a violation. |
| `because` | State why the rule exists. |

Every entry requires `because`, as other root-level rules require a reason.

## 2. Activation

The tier requires the `TYPESAFE_API_KEY` environment variable before it evaluates rules.
When the key is absent, `check` reports every configured calibrated rule as an individual, named `skipped` entry.
Each skipped entry carries the rule id, its configured `because`, and the reason `TYPESAFE_API_KEY is absent`.
The report must retain these entries rather than omit them.

This reuses the principle of rule 4, `empty-rule-set`: a rule that checks nothing must not look like a pass.

The built-in `config-meaning` check is a deliberate, stricter exception to this general activation rule.
It also requires `--prove` as explicit permission for each invocation.
A routine CI or pre-commit check must not make paid requests because an unrelated tool has set the same credential.
Without `--prove`, this check produces no assessment and makes no request.
With `--prove`, a missing key or a failed batch produces one `skipped` entry for the whole batch.
A contradiction with confidence below 0.7 produces an `undecided` entry with the rule's own `because` text.
Its evidence includes the returned confidence and probabilities, but it has no `confidence` field.
A contradiction at or above 0.7 produces a finding with a `confidence` field.
All three outcomes carry `tier: "calibrated"`; they remain advisory and cannot enter todo, including in modules marked `strict`.
The general field, threshold, and todo design below applies to future user-authored rules.

An exhaustive allow list does not require a semantic assessment.
Static config validation alone cannot establish the set of real values, but the dependency graph supplies those values.
A deterministic graph check can detect an exhaustive allow list; the claim that static analysis cannot catch this case was incorrect.
The built-in assessment instead checks whether the configured shape contradicts its own reason.

## 3. Violation shape

Each calibrated result carries the five required fields `rule`, `path`, `evidence`, `because`, and `do`.
It also carries two fields that deterministic violations do not carry:

| Field | Value |
| --- | --- |
| `confidence` | The model's own calibrated number, from 0 to 1. |
| `tier` | The literal string `"calibrated"`. |

A consumer can filter or sort results by `tier` without parsing text to identify their class of evidence.
A confidence value describes the calibrated result alone; it never modifies a deterministic violation.

## 4. Threshold and exit code

The report includes every calibrated result, including those that cannot affect the exit code.
The rule's own `at` field determines whether its result can block a check.

| Config and confidence | Report and todo | Effect on `check` |
| --- | --- | --- |
| `at` is absent | Report every result with `tier: "calibrated"`. Each result is eligible for todo. | Advisory only. The result never affects the exit code. |
| `at` is present and `confidence >= at` | Report the result as a violation, subject to the existing todo rules. | Treat it like a deterministic violation for the exit code and the hard gate in a `strict` module. |
| `at` is present and `confidence < at` | Report the result as information. | The result does not block the check or affect its exit code. |

The design requires two independent choices.
The API key enables evaluation; the `at` field permits a result to block a check.
The advisory default does not grant that second permission.

## 5. Todo eligibility and identity

Calibrated results are eligible for todo under the existing rules for module debt.
The fingerprint hashes `rule`, `path`, and a hash of the `ask` text itself.
It never includes `confidence`.
This identity freezes the question, not the answer that the model returns.

A model update can change a score without changing that identity.
A score change alone must not unfreeze or refreeze existing debt.
A change to the `ask` text changes the identity because it changes the question.

This reuses the existing pattern for the `type-leak` fingerprint.
That fingerprint removes the mutable `referenced by` suffix from the evidence before it computes the hash.
Both fingerprints exclude details that can vary while the debt stays the same.

## 6. Interaction with strict modules

Apply the threshold and exit behavior in decision 4 to modules marked `strict`.
That table defines the interaction; this tier adds no separate condition for those modules.

## 7. Projection through `rules <path>`

When a calibrated rule's `tags` or `glob` matches the queried path, `rules <path>` shows it in a new section.
The section shows the rule's `ask` text and its configured `at` threshold, if present.
It never shows a score because a query before an edit does not evaluate the future code.

This projection gives an agent the question before the agent writes a line.
It follows the same principle as the existing `allowDeny`, `order`, and `point` projections.
