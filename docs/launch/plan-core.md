# Launch Plan Core

`CANDIDATE_NOT_ACTIVE`

This document is the structural-root candidate for the Launch Plan. It contains plan structure only. It does not select, authorize, execute, or report runtime tasks.

## Task structure

| task_id | depends_on | lane | migration_slot | priority | order |
| --- | --- | --- | --- | ---: | ---: |
| `R0-A` | — | `shared` | `none` | 10 | 10 |
| `GOV-1` | `R0-A` | `shared` | `none` | 20 | 20 |
| `R0-B` | `GOV-1` | `shared` | `none` | 30 | 30 |
| `STG-FIX` | `R0-B` | `money` | `SLOT-1` | 40 | 40 |
| `SEC-1` | `STG-FIX` | `money` | `SLOT-2` | 50 | 50 |
| `AUTH-1` | `SEC-1` | `money` | `SLOT-3` | 60 | 60 |
| `YEAR-1` | `AUTH-1` | `money` | `SLOT-4` | 70 | 70 |
| `REFUND-1B` | `YEAR-1` | `money` | `SLOT-5` | 80 | 80 |
| `BILL-1` | `REFUND-1B` | `money` | `none` | 90 | 90 |
| `SKILL-1A` | `STG-FIX` | `product` | `SLOT-6` | 100 | 100 |
| `SKILL-1B` | `SKILL-1A` | `product` | `none` | 110 | 110 |
| `PAY-1` | `STG-FIX` | `product` | `none` | 120 | 120 |
| `CI-1` | `STG-FIX` | `product` | `none` | 130 | 130 |
| `REL-1` | `BILL-1`, `SKILL-1B`, `PAY-1`, `CI-1` | `shared` | `none` | 140 | 140 |

## Ready-candidate derivation rule

The read-only derivation evaluates each node using live completion evidence external to this file. A task is ready only when:

`ready(task) = NOT completed(task) AND every dependency is completed`

The derivation then emits eligible node IDs ordered by ascending `priority`, ascending `order`, and finally `task_id` as a deterministic tie-breaker. `plan-core` stores no progress, runtime, or completion state; `completed(task)` is resolved from external evidence at derivation time.

The derivation output is a projection called a ready-candidate set. A ready candidate is not an authorized task.

## Authority boundary

- Only a dedicated Task Issue with an exact canonical task-card binding and an exact, current Owner gate can become the current executable task.
- The Owner gate must bind the repository identity, fresh refs, exact task-card blob, and permitted action scope before Generator work begins.
- Without a valid Owner gate, the required result is `NO_PRODUCT_TASK_AUTHORIZED`.
- An Agent must not choose one task from multiple ready candidates, infer authorization from priority, or turn this file into runtime state.
- Priority and order determine only deterministic presentation order; they do not grant authorization.
- An Agent must not autonomously choose among multiple ready candidates.
- This candidate remains `CANDIDATE_NOT_ACTIVE` until a separate Owner cutover gate accepts its exact blob. Even then, acceptance is a separate activation decision; this PR provides no activation.
