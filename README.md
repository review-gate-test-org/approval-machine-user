# approval-machine-user

Approval path: **a machine user approves a PR after Copilot code review approved it.**
The same scenario runs in sibling repos under other approval paths.

| Path | Stack | Code owners |
|------|-------|-------------|
| `backend/` | Java 21, Maven | @review-gate-test-org/backend, @venetrius-review-bot |
| `client/` | TypeScript, React (Vite) | @review-gate-test-org/frontend |
| everything else | | @venetrius, @JacobiCamunda (humans) |

## Build

```bash
cd backend && mvn verify
cd client && npm ci && npm run lint && npm run build
node --test .github/machine-user-approval/approve.test.js
```

## What this path tries to prove

A regular GitHub account (`venetrius-review-bot`) can turn Copilot's 🟢 into a real approval that
GitHub's own branch protection counts, scoped by `CODEOWNERS`. No custom status check: GitHub's
native "code owner review required" rule decides mergeability.

## How it's configured

Step-by-step setup to replicate this repo: [docs/SETUP.md](docs/SETUP.md).

- **Ruleset on `main`**: PR required, 1 approval, code-owner review required, stale approvals dismissed
  on push, required checks `backend` and `client`, Copilot automatic review on push.
- **CODEOWNERS**: the bot is listed only on `/backend/`. A human catch-all owns everything else,
  including `.github/`, `README.md` and agent instruction files.
- **Workflow** [`.github/workflows/machine-user-approval.yml`](.github/workflows/machine-user-approval.yml)
  runs on `pull_request_target` (default-branch code only) and approves as the bot when:
  Copilot's latest review of the head commit is `APPROVED`, the bot is a code owner of every changed
  file, no file is hard-denied in [`approve.js`](.github/machine-user-approval/approve.js), and the bot is not the author.
- **Token**: fine-grained PAT owned by the bot, scoped to this repo (Pull requests: read & write,
  Contents: read), stored as `MACHINE_USER_TOKEN` in environment `machine-user-approval` (branch `main` only).
- **Copilot setting** (UI only): "Allow Copilot to approve pull requests" **on** (a single setting, which also makes
  Copilot's approvals count toward merge requirements), path limit `backend/**`. Copilot's approval can't satisfy
  code-owner review, so the bot's approval is still what unblocks the merge.
- **No `pull_request_review` trigger**: GitHub holds runs triggered by Copilot as "Approve workflows to run".
  The run started by the author's push waits up to 15 min for Copilot's review of that commit. A
  15-min schedule is meant to pick up later reviews (but see Limits: it has not fired yet).

## Results

Observed on 2026-10-29 with Copilot's approval setting on. The PRs are left open and never merged.
"Merge state" is GitHub's `mergeStateStatus` after all reviews.

| PR | Change | Copilot | Bot | Merge state |
|----|--------|---------|-----|-------------|
| A: [#2](https://github.com/review-gate-test-org/approval-machine-user/pull/2) | backend only, benign | 🟢 Approved (`APPROVED`) | Approved 29 s after Copilot | **CLEAN**: mergeable, no human |
| B: [#3](https://github.com/review-gate-test-org/approval-machine-user/pull/3) | backend only, off-by-one bug | 🔵 Needs a closer look (`COMMENTED`), with a comment on the bug | Skipped: Copilot didn't approve | **BLOCKED** |
| C: [#4](https://github.com/review-gate-test-org/approval-machine-user/pull/4) | backend + `README.md` | 🟢 Approved (`APPROVED`) | Skipped at once: may not approve `README.md` | **BLOCKED**: needs a human code owner |

Verified:
- **Copilot alone doesn't unblock.** On A, the PR stayed BLOCKED for about 30 s between Copilot's
  approval and the bot's. Copilot's approval doesn't satisfy code-owner review.
- **No held runs.** There were 0 `action_required` runs, so no "Approve workflows to run" prompt
  appeared. Nothing here triggers on Copilot's review.
- **A new push dismisses the bot's approval.** On the closed throwaway
  [#5](https://github.com/review-gate-test-org/approval-machine-user/pull/5), a push dismissed both
  the bot's and Copilot's approvals 1 s later, and the PR went BLOCKED. Copilot re-approved the new
  commit about 70 s later and the bot 11 s after that, so the PR became mergeable again with no human.
- **Without the Copilot setting, nothing happens.** Copilot posts "🟢 Approval recommended" as
  `COMMENTED`, never `APPROVED`, so the bot never approves. This was the first round on #2 and #4.
- **Copilot's verdict varies on identical code.** B got 🟡 "Changes recommended" in the first round
  and 🔵 "Needs a closer look" in the second, with the same bug comment. Neither is `APPROVED`.

Not verified live:
- **The bot never approves its own PR.** This is covered by unit tests, and GitHub doesn't let a PR
  author approve their own PR anyway. No PR was opened as the bot: its token is never handled outside
  the secret.

## Limits

- **Non-human account**: it's a real user, so it needs an org seat and Write access, and org policy
  must allow machine accounts. That worked on this free org (verified). Seat cost and policy in a paid
  or enterprise org are unverified. Add it to the repo as a person, not via a team (see the setup guide).
- **Token custody**: a 30-day PAT stored as an environment secret that only `main` can use. Whoever
  holds the token can approve as the bot, but the approval only satisfies code-owner review where
  CODEOWNERS lists the bot (verified on C). Rotation is manual: see the setup guide.
- **Copilot setting is UI-only**: it can't be read or set through the API, so it's easy to turn off
  without anyone noticing. Then the bot silently stops approving and PRs fall back to humans.
- **15-min wait**: each waiting run occupies a runner. Here Copilot took 1–1.5 min, so the wait was
  short (verified on 4 pushes). A Copilot review that arrives after 15 min relies on the schedule. **The schedule
  has not fired once since the repo was created** (verified: 0 `schedule` runs in 5.5 h; cause unknown).
  Until it does, a late review needs a manual `workflow_dispatch` or a new push.
- **Transient API errors**: once, all three runs failed on a `503` from the GitHub API (verified). The
  workflow now retries 3 times (not yet tested against a real outage).
- **Path controls**: v1 scope is CODEOWNERS plus a hard-coded deny list. Fine-grained allow/block lists are
  [#1](https://github.com/review-gate-test-org/approval-machine-user/issues/1).
