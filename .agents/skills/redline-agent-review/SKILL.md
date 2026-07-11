---
name: redline-agent-review
description:
  Resolve durable Redline review threads through the local redline CLI. Use when
  asked to inspect one Redline comment or all pending comments, implement or
  decline requested feedback, validate the result, record an accepted, rejected,
  or deferred agent reply, recover from stale versions, or explicitly reopen a
  decided thread.
---

# Redline agent review

1. Verify the current Git worktree and run `redline agent review <comment-id>`
   or `redline agent review-all`. Never override a workspace mismatch.
2. Read the root, anchors, full chronological thread, versions, current
   fingerprint, and accepted context before changing files.
3. Inspect the referenced source and decide:
   - Implement actionable feedback, then run validation proportional to the
     change.
   - Reject only with a concrete technical reason.
   - Defer only with a specific blocker or prerequisite.
4. Re-fetch the packet after implementation and before acceptance. If the root,
   thread, or file context changed, reconcile the new evidence instead of
   submitting a stale response.
5. Write the complete reply to a file or standard input. Record the decision
   with:

   ```sh
   redline agent respond <comment-id> --decision accepted --input reply.md
   ```

   Use `rejected` or `deferred` only with the required explanation. Acceptance
   means the comment request was implemented and validated; it does not approve
   a file, stage changes, or commit.

6. On a stale or invalid-state error, fetch the packet again. Do not
   automatically retry a mutation with altered context.
7. Reopen a decided thread only when explicitly required:

   ```sh
   redline agent reopen <comment-id>
   ```

8. Fetch the final packet and report its persisted state, reply, versions, and
   validation evidence.

Use `--server-url` or `REDLINE_SERVER_URL` only for a credential-free loopback
HTTP origin. Agent thread commands require a verified running server and never
fall back to direct mode.
