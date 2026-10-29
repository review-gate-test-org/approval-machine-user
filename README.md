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
  15-min schedule picks up later reviews.

## Results

RESULTS_PLACEHOLDER

## Limits

- **Non-human account**: needs an org seat and Write access; it's a real user, so org policy
  (and GitHub's terms on machine accounts) must allow it. Unverified for a paid org.
- **Token custody**: a long-lived PAT. Whoever holds it can approve as the bot, but the approval
  only satisfies code-owner review where CODEOWNERS lists the bot. Rotation is manual (30-day expiry).
- **15-min wait**: Copilot reviews that take longer are picked up by the schedule (up to 15 min more,
  and GitHub may delay scheduled runs). Each waiting run occupies a runner.
- **Path controls**: v1 scope is CODEOWNERS plus a hard-coded deny list. Fine-grained allow/block lists are a follow-up.
