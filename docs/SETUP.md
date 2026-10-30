# Setting up the machine-user approval path

How to rebuild this repo from scratch: a regular GitHub account approves PRs after Copilot code
review approves, and only for paths where CODEOWNERS lists it.

You need two accounts:
- **Owner**: an org owner (here `venetrius`). Creates the repo, settings and secret.
- **Bot**: a separate, ordinary GitHub user (here `venetrius-review-bot`). Creates the token.

Replace `ORG`, `REPO` and `BOT` below with your values.

## 1. Repo and files (owner)

1. Create the repo and copy these files from this repo:
   - [`.github/workflows/machine-user-approval.yml`](../.github/workflows/machine-user-approval.yml): the workflow
   - [`.github/machine-user-approval/approve.js`](../.github/machine-user-approval/approve.js): the decision logic and the hard-deny list
   - [`.github/machine-user-approval/approve.test.js`](../.github/machine-user-approval/approve.test.js): unit tests (`node --test`)
   - [`.github/machine-user-approval/ruleset.json`](../.github/machine-user-approval/ruleset.json): the ruleset applied in step 5
   - [`.github/workflows/ci.yml`](../.github/workflows/ci.yml): CI whose jobs `backend` and `client` are the required checks
   - [`.github/CODEOWNERS`](../.github/CODEOWNERS)

   If your CI has different job names, edit `required_status_checks` in `ruleset.json` to match
   **before** step 5. Otherwise every PR waits forever for checks that never report.
2. In CODEOWNERS, list the bot **by name** only on the paths it may approve, and give every
   other path, including the catch-all `*`, to humans:
   ```
   *          @human1 @human2
   /backend/  @ORG/backend @BOT
   /client/   @ORG/frontend
   ```
3. Push to `main` **before** creating the ruleset in step 5, which blocks direct pushes.

## 2. Add the bot to the org and the repo (owner)

1. Invite the bot to the org at `https://github.com/orgs/ORG/people` (**Invite member**). The
   bot accepts while logged in as the bot.
2. Give the bot **Write** on this repo **as a person**, at
   `https://github.com/ORG/REPO/settings/access` (**Add people**).

> **Don't add the bot to a team.** A team named in CODEOWNERS makes all its members code
> owners of that path. That would let the bot's approval count for the team's paths and in
> every other repo the team can access. Only the bot's own CODEOWNERS entries should count.

3. Check that the org allows fine-grained tokens:
   `https://github.com/organizations/ORG/settings/personal-access-tokens`, under "Allow access
   via fine-grained personal access tokens".

## 3. Create the token (bot)

At `https://github.com/settings/personal-access-tokens/new`, logged in as the bot. Every field
is on the same page:

| Field | Value |
|-------|-------|
| Resource owner | `ORG` (pick this first: it controls the repository list) |
| Expiration | 30 days |
| Repository access | **Only select repositories**, then `REPO` |
| Repository permissions | **Pull requests: Read and write**, **Contents: Read-only** (Metadata: Read is added automatically) |

Click **Generate token** (or **Generate token and request access**) and copy it. GitHub shows
it only once. Don't paste it anywhere except the secret in step 4.

If the org requires approval, the owner approves the request at
`https://github.com/organizations/ORG/settings/personal-access-token-requests`.

## 4. Store the token (owner)

The secret goes in an **environment that only `main` can use**. That way only the
default-branch workflow can read it, never code from a PR branch.

```bash
gh api -X PUT repos/ORG/REPO/environments/machine-user-approval \
  -F 'deployment_branch_policy[protected_branches]=false' \
  -F 'deployment_branch_policy[custom_branch_policies]=true'
gh api -X POST repos/ORG/REPO/environments/machine-user-approval/deployment-branch-policies \
  -f name=main -f type=branch
gh secret set MACHINE_USER_TOKEN -R ORG/REPO --env machine-user-approval   # paste at the prompt
```

You can also do this in the UI: **Settings → Environments → New environment**
`machine-user-approval`. Under **Deployment branches and tags**, choose **Selected branches and
tags** and add `main`. Then use **Add environment secret** to store `MACHINE_USER_TOKEN`.

## 5. Ruleset on `main` (owner)

```bash
gh api -X POST repos/ORG/REPO/rulesets --input .github/machine-user-approval/ruleset.json
```

[`ruleset.json`](../.github/machine-user-approval/ruleset.json) sets these rules: a PR is
required with 1 approval, **code-owner review required**, stale approvals dismissed on push,
required checks `backend` and `client` (GitHub Actions), and **Copilot automatic review on
push**. It has no bypass actors. Run the command from a checkout that has `ruleset.json` (step 1).

## 6. Let Copilot submit real approvals (owner, UI only)

At `https://github.com/ORG/REPO/settings`, go to **Copilot → Code review → Approvals**:

| Setting | Value | Why |
|---------|-------|-----|
| Allow Copilot to approve pull requests (one setting, also labelled "Copilot approvals can count toward merge requirements") | **on** | Without it, Copilot posts a `COMMENTED` review headed "🟢 Approval recommended", never `APPROVED`, so the bot never approves (observed on [#2](https://github.com/review-gate-test-org/approval-machine-user/pull/2) and [#4](https://github.com/review-gate-test-org/approval-machine-user/pull/4)). |
| Limit approvals to certain file paths | `backend/**`, the same scope as the bot in CODEOWNERS | With the setting on, Copilot's approval counts toward the "1 approval" rule within this scope. It can't satisfy code-owner review, so the bot's approval is still needed. The scope matters if code-owner review is ever turned off. |

If the org setting "Count Copilot approvals toward merge requirements" is fixed at the org level,
it must be set to *Let repositories decide*.

## 7. Smoke test (owner)

```bash
gh workflow run machine-user-approval.yml -R ORG/REPO
gh run list -R ORG/REPO -w machine-user-approval.yml -L1   # expect: success
```

A green run means the token authenticated. With no open PRs it approves nothing. Then open a PR
that touches only bot-owned paths. When Copilot's review is 🟢, the bot should approve within
about 30 s. If Copilot takes longer than 15 min, the 15-min schedule is the fallback. It had not fired
here yet (see the README), so run `gh workflow run machine-user-approval.yml` by hand if needed.

## Rotation

The token expires after 30 days. Before it expires, the bot creates a new one with the same
settings (step 3), the owner replaces `MACHINE_USER_TOKEN` (step 4), and the bot deletes the old
token. If the secret is missing or expired, the workflow run fails and no approvals happen, so
PRs fall back to needing a human.
