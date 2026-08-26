# Agent PR Review Loop

Operational reference for the automated pull-request review loop. `AGENTS.md` holds the policy - what you must and must not do. This file holds the mechanics - what the reviewer emits, where it appears, and how to read it correctly.

Read this before requesting your first review on a pull request.

Two roles appear throughout and are frequently different tools:

- **The authoring agent** - whichever agent prepared the branch and opened the PR. Any coding agent working in this repository.
- **The reviewer** - the Codex review bot, invoked by commenting `@codex review` on the PR. Its GitHub identity is `chatgpt-codex-connector[bot]`.

## Requesting A Review

Push the branch, open the pull request against the intended base branch for the work (normally the repository default branch; use an approved stacked or deployment branch when repo instructions require it), then request review.

If automatic Codex review starts for the current head, do not add a redundant `@codex review` comment. Use the push time, PR-ready time, or other automatic-run marker as the request boundary for correlation. If no automatic run starts within a reasonable time, comment `@codex review` on the PR.

The reviewer adds an `:eyes:` reaction to the triggering comment while it works and removes it when finished. An absent `:eyes:` therefore means either "not started" or "already done"; on its own it is not a progress signal.

## What The Reviewer Emits

Results appear on two surfaces: the pull-request review surface and the top-level issue-comment surface. Findings can arrive on either surface, so neither can be skipped.

### Pull-Request Review With Inline Comments

An entry in `pulls/<n>/reviews` with state `COMMENTED`, plus one inline comment per finding in `pulls/<n>/comments`. Each inline comment carries a severity badge such as `[P1]`, a summary line, and a file and line reference.

### Pull-Request Review With No Inline Comments

The same review entry with no attached inline comments. This means that review round raised nothing on the pull-request review surface.

### Top-Level Issue Comment

An entry in `issues/<n>/comments`. Two relevant forms have been observed:

- Findings: usually headed `### Review Finding`, listing severity-tagged bullets with file and line links, followed by a testing section.
- Summary: beginning `Codex Review: Didn't find any major issues.` followed by varying closing text and `**Reviewed commit:** <sha>`.

A `Didn't find any major issues` summary does not prove the round was clean. It speaks only to major issues and has been observed alongside actionable findings from the same run. Always inspect both surfaces before concluding a round found nothing.

## Correlating A Result With Its Round

Three endpoints matter, and every one of them must be paginated. The API returns 30 items per page by default.

| Endpoint | Carries | Correlate by |
|---|---|---|
| `pulls/<n>/reviews` | Review entries | `user.login`, current head SHA, newest `submitted_at` after your request boundary |
| `pulls/<n>/comments` | Inline findings | `pull_request_review_id` |
| `issues/<n>/comments` | Findings and summaries | `user.login`, `created_at`, and commit evidence in the body |

`pulls/<n>/comments` accumulates inline comments from every review on the PR. Its contents say nothing about what the latest review found until comments are correlated to the latest review round.

Top-level issue comments can arrive late. Do not attach every bot-authored issue comment created after your latest request boundary to the current round by timestamp alone. Correlate summaries by their `Reviewed commit` SHA. Correlate finding comments by commit evidence in their links/body when present, or by a clearly bounded request window; if the body cannot be tied to the current head, treat the result as ambiguous and inspect manually before declaring the round clean.

## Procedure

Note the current head SHA and the request boundary before requesting or relying on review. For manual reviews, the request boundary is the `@codex review` comment time. For automatic reviews, use the push time, PR-ready time, or other automatic-run marker.

1. Fetch all PR reviews with pagination. Keep every review whose author is `chatgpt-codex-connector[bot]`, whose commit matches the current head, and whose submission time falls after your request boundary. There may be none: a summary-only round creates no PR review. Do not start another manual review while a previous request is still active unless you are explicitly abandoning that attempt.
2. For every matching review, fetch all PR comments with pagination and keep comments whose `pull_request_review_id` equals that review's `id`. Those are the inline findings for this round.
3. Fetch all issue comments with pagination. Keep bot-authored comments created after your request boundary, then classify bodies starting `### Review Finding` as findings and bodies starting `Codex Review:` as summaries. Summaries must name the current head. Findings must be correlated to the current head or reconciled manually before they are used to judge the latest round.
4. If a manual `@codex review` request was used and you can observe the triggering comment reactions, wait for the `:eyes:` reaction to be removed before the final result read. If `:eyes:` remains beyond a reasonable wait, record an incomplete/abandoned review attempt. If no reaction is observable, such as with an automatic run or limited API visibility, wait for a matching review or summary and then perform a final paginated read of both result surfaces after a short stabilization window. Treat remaining ambiguity as incomplete rather than clean.

The round has completed only after the reviewer has produced a completion signal and the final paginated result read has found matching output. Prefer the observed `:eyes:` reaction being removed as the cue to perform that final read. When reactions are not observable, use a matching review or a summary naming the current head plus a short stabilization window before the final read. If the cue appears but no matching review, summary, or finding can be correlated to the current head, treat the attempt as incomplete. The round is clean only when it has completed, has no correlated inline findings, and has no correlated top-level `### Review Finding` comment. Keep completion and cleanliness separate.

## Reconciling The Commit

Reviews and summary comments name the commit reviewed. Confirm that SHA matches the current head before treating a result as covering your latest push. A review of an earlier commit says nothing about work pushed after it.

For top-level finding comments, look for commit evidence in the linked file URLs or nearby bot output. If a finding cannot be reconciled to the current head, do not ignore it and do not automatically attribute it to the current round; inspect the timeline and answer with the correlation decision.

## Waiting

Wait a reasonable amount of time for the review to start and finish. Do not wait indefinitely.

If the review does not start, or starts and produces no result after a reasonable wait, stop waiting and add a PR comment recording that automated review was requested and did not complete. This is an explicit incomplete/abandoned review outcome for the current attempt, not a clean review. Resume by requesting review again later, or proceed only if the user or maintainer explicitly accepts that the automated review is unavailable.

Never infer approval from silence. If a watcher reports nothing, run the procedure above by hand before drawing a conclusion.

## Acting On The Result

Verify each finding against the source before acting on it. Findings are usually useful, but a finding that does not hold should be answered with evidence rather than implemented.

Address relevant findings in the same PR with normal follow-up commits. Do not force-push, rewrite, or overwrite branch history.

If a finding is less relevant, or belongs to a different topic than the originating ticket, file a follow-up issue instead and mention that decision in the PR.

After each new push, request `@codex review` again unless automatic Codex review starts for that push, wait for the result, and repeat until a round completes with no findings on either surface. If all findings are resolved without code changes (for example answered with evidence or moved to follow-up issues), request another review on the unchanged head; otherwise record why the finding disposition is terminal.

A clean round is one signal, not proof. The authoring agent stays responsible for checking its own work.
