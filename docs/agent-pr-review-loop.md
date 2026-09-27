# Agent PR Review Loop

Operational reference for the automated pull-request review loop. `AGENTS.md` holds the policy - what you must and must not do. This file holds the mechanics - what the reviewer emits, where it appears, and how to read it correctly.

Read this before requesting your first review on a pull request.

Use the author identity selected by the Agent GitHub Identity section in
`AGENTS.md` for ordinary operations and review-result reads. In configured-App
mode, only the literal `@codex review` trigger and its necessary identity check
may use an explicitly authorized, separately verified linked-human route.
Without a configured App, the existing authorized account can request review
after actor verification; a special trigger helper is not required.
Keep `chatgpt-codex-connector[bot]` as the independent review-result identity.
Neither posting a trigger nor its author's identity proves review completion.

## Review Trigger Identity And Handoff Readiness

1. Record the full current head and request boundary (manual comment time, or
   push/Ready time for an automatic run). Inspect paginated comments, reviews,
   inline findings, and reactions before any trigger. Do not duplicate an
   active run or a completed clean current-head round with verified thumbs-up.
2. Make a reviewable PR Ready under the normal SDLC; the handoff gate below
   must not keep it Draft and prevent review from starting. Automatic reviews
   need no manual trigger identity. Only a needed manual request is blocked
   when its authorized identity is unavailable.
3. Use the configured route. Only for a user-requested identity experiment,
   send the literal App trigger and observe for five minutes. Reviewer eyes,
   correlated inline/top-level findings, a current-head review, or a running
   or completed current-head summary (including summary-only rounds) all
   acknowledge review. Process those results instead of sending a duplicate.
   Every acknowledgement must match the recorded head and occur after the
   current request boundary: use review submission time, finding creation
   time, reaction creation time, or the matched summary row's own run time.
   For an edited summary, do not use the comment's original creation time or
   another row's update. Prior same-head results are not a new acknowledgement.
   The literal trigger requests Code Review: a Security Review row or shared
   eyes alone cannot acknowledge Code Review. Track other required review
   types separately; wait for them to terminate before starting a missing
   Code Review to avoid overlapping rounds.
   If truly unacknowledged, re-read the head and both surfaces before one
   identical, explicitly authorized and actor-verified human trigger. Abort
   the comparison if the full SHA changed; restart review planning for the new
   head rather than triggering it under the old experiment. For every later
   request, verify current task/user authorization or independently trusted
   standing local configuration; a past one-off test never grants authority.
   Use the verified route directly only while that authorization still applies.
4. Never automatically retry a trigger write. Reconcile uncertain outcomes
   with the normal selected author identity (App when configured, otherwise
   the environment's authorized account). Missing auth remains blocked; do
   not choose another account or operation to get around the failure.
5. Wait for a fresh completed current-head round with no findings on either
   surface, after addressing or dispositioning earlier findings. Deferral alone
   is not approval. Read both surfaces again after stabilization and verify
   thumbs-up with the procedure below. No eyes alone is not completion.
6. If a clean round still lacks correlated thumbs-up, record incomplete
   approval and ask the maintainer to verify or explicitly re-request it.
   A bounded helper may refuse same-head retries: hand that request to the
   maintainer rather than bypassing the helper or repeatedly auto-pinging.
   Failed, stale, ambiguous, or incomplete review remains blocked. Required
   checks and formal GitHub approval are separate; the agent does not merge.

### Verifying Reviewer Thumbs-Up

Use the normal selected identity for these reads; paginate every endpoint.
Reaction counts or emoji in boilerplate are not reviewer approval.

- Read `repos/<owner>/<repo>/issues/<pr>/reactions?per_page=100` with
  `gh api --paginate`. A PR is also an issue; this is the PR-body reaction
  surface used by both manual and automatic Codex reviews.
- If a manual trigger or a correlated reviewer result comment has reactions,
  also read `repos/<owner>/<repo>/issues/comments/<comment-id>/reactions?per_page=100`
  with pagination. Automatic runs need no synthetic trigger comment.
- Keep only `content="+1"` from `chatgpt-codex-connector[bot]`. Inspect each
  reaction's `created_at`, not aggregate counts, and require it to be at or
  after the recorded boundary of the current round. A pre-existing reaction
  cannot cover a new head or a later same-head round.
- Do not assume the bot refreshes a persistent PR reaction. Fresh PR-body
  reactions were observed after successive automatic rounds in the identity
  pilot rollout, but verify freshness each time. If an integration keeps an
  old `+1`, require a fresh reviewer approval on a current-head result comment
  through the maintainer verification path; the old reaction is not enough.
- PR-body reactions carry no head/review ID. Accept one only after proving
  that all earlier rounds had terminated before this round's boundary and no
  other manual/automatic round overlapped it. Record that timeline evidence.
  Timestamp alone is insufficient: a late old-head reaction can arrive after
  a new boundary. If overlap cannot be excluded, require a fresh reaction on
  an immutable reviewer result comment explicitly naming this head/round, or
  keep approval incomplete for maintainer verification.
- Re-read the head after collecting results. Require matching completed review
  or summary evidence and no findings on either surface after stabilization.
  In a review-summary table, correlate each code/security row to its own SHA;
  no required row may still be running or failed. A reaction-only result lacks
  immutable head evidence, so record incomplete and ask the maintainer to
  verify it rather than inferring approval from silence.
- If the reaction's actor, time, or round cannot be established, keep approval
  incomplete and use the maintainer path above. Never add approval yourself,
  delete reactions to manufacture freshness, or weaken branch protection.

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

### Persistent Summary Tables

The issue-comment endpoint also returns edited comments marked
`<!-- codex-pull-request-review-summary -->` with a `Codex Review Summary`
table. Retain each current body even if created before this round, using the
same paginated `issues/<n>/comments` read.
For each row, extract Review type (Code Review or Security Review), Status,
Commit SHA, trigger, and its own `<relative-time datetime="...">` run timestamp.
Verify that an abbreviated SHA uniquely matches the recorded full head.
Match the requested type and require the row's run time after the request
boundary. Do not substitute another row's time, comment creation time, or
global `updated_at`. Unknown or missing fields are incomplete evidence.
Running acknowledges work, not completion; only a matching Completed row
can signal completion. Re-read after stabilization, inspect both finding
surfaces, and apply the separate fresh thumbs-up gate. A table describes
activity, not cleanliness. Account for every required review type.

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
3. Fetch all issue comments with pagination and retain all reviewer-authored bodies before classification. For one-off `### Review Finding` and `Codex Review:` comments, require current-head evidence and a creation time after the request boundary. For persistent summary tables, do not filter by comment creation time: apply the per-row type, head, run-time and completed-status rules above. Manually reconcile ambiguous findings; never treat a running table row as a completed result.
4. If a manual `@codex review` request was used and you can observe the triggering comment reactions, wait for the `:eyes:` reaction to be removed before the final result read. If `:eyes:` remains beyond a reasonable wait, record an incomplete/abandoned review attempt. If no reaction is observable, such as with an automatic run or limited API visibility, wait for a matching review or summary and then perform a final paginated read of both result surfaces after a short stabilization window. Treat remaining ambiguity as incomplete rather than clean.

The round has completed only after the reviewer has produced a completion signal and the final paginated result read has found matching output. Prefer the observed `:eyes:` reaction being removed as the cue to perform that final read. When reactions are not observable, use a matching review or a summary naming the current head plus a short stabilization window before the final read. If the cue appears but no matching review, summary, or finding can be correlated to the current head, treat the attempt as incomplete. The round is clean only when it has completed, has no correlated inline findings, and has no correlated top-level `### Review Finding` comment. Keep completion and cleanliness separate.

## Reconciling The Commit

Reviews and summary comments name the commit reviewed. Confirm that SHA matches the current head before treating a result as covering your latest push. A review of an earlier commit says nothing about work pushed after it.

For top-level finding comments, look for commit evidence in the linked file URLs or nearby bot output. If a finding cannot be reconciled to the current head, do not ignore it and do not automatically attribute it to the current round; inspect the timeline and answer with the correlation decision.

## Waiting

Wait a reasonable amount of time for the review to start and finish. Do not wait indefinitely.

If the review does not start, or starts and produces no result after a reasonable wait, stop waiting and add a PR comment recording the incomplete attempt. Keep handoff blocked; timeout or acceptance that the service is unavailable is not approval. Ask the maintainer to restore review availability or explicitly arrange a new request after confirming no review is active. Never bypass the clean current-head review and thumbs-up gate.

Never infer approval from silence. If a watcher reports nothing, run the procedure above by hand before drawing a conclusion.

## Acting On The Result

Verify each finding against the source before acting on it. Findings are usually useful, but a finding that does not hold should be answered with evidence rather than implemented.

Address relevant findings in the same PR with normal follow-up commits. Do not force-push, rewrite, or overwrite branch history.

If a finding is less relevant, or belongs to a different topic than the originating ticket, file a follow-up issue instead and mention that decision in the PR.

After each new push, request `@codex review` again unless automatic Codex review starts for that push, wait for the result, and repeat until a round completes with no findings on either surface. If all findings are resolved without code changes (for example answered with evidence or moved to follow-up issues), request another review on the unchanged head; otherwise record why the finding disposition is terminal.

A clean round is one signal, not proof. The authoring agent stays responsible for checking its own work.
