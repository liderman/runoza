# Limits of response by model

2026-11-11. Local redesign, no push.

Fixed 4,096 are removed from chat and agent. The directory stores maxOutputTokens; manual overrides are stored in existing overrides. Empty field means autodetermination, unknown limit is not transmitted to the API. Positive integer is checked. The thinking budget is now linked to an effective limit instead of a 3072 ceiling.

Checks: full npm check (13 unit tests, types, assembly, formatting, package boundaries and licenses) PASS. Chat and agent integration: 24 PASS tests. Actual payload checked for 16384 (manual chat), 24576 (manual agent), 32768 (catalogue) and missing value. Saving override when updating the directory, returning to autodetermination, snapshot of queue parameters, failure for zero/negative/fractional values, and budget/limit ratio checked.

Local API/worker and Runoza.app updated. No new dependencies and migrations; image collected on top of the previous verified runtime with updated artifacts. Previous image saved as runoza:before-output-limit.

Details: ../models.md. Directory field source: https://openrouter.ai/docs/api/api-reference/models/get-models.

UI tested in light and dark themes on the local desktop: field, focus, error for zero, lock save, clear field and close without false warning. After updating the directory, the Claude Sonnet 5.5 form showed 128,000 tokens from metadata. User redefinitions in the work unit did not change. API worker and worker healthy; when Docker was recreated, the missing connection to the declared code-a network was restored.
