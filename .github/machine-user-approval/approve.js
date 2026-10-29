// Machine-user approval: the bot account approves an open PR to the default branch when
//   - Copilot code review APPROVED the PR's head commit, and
//   - the bot is a code owner of every changed file (CODEOWNERS on the default branch), and
//   - no changed file is on the hard-deny list, and
//   - the bot is not the PR author.
// Otherwise it does nothing. Branch protection (code-owner review) decides mergeability.

const COPILOT = 'copilot-pull-request-reviewer[bot]';

// Paths the bot never approves, whatever CODEOWNERS says.
const HARD_DENY = [
  /^\.github\//,
  /^(docs\/)?CODEOWNERS$/,
  /^(AGENTS|CLAUDE|GEMINI|REVIEW|README)\.md$/,
  /^\.(claude|agents)\/skills\//,
];

// CODEOWNERS glob -> RegExp. Supports *, **, ?, leading / (anchor) and trailing / (directory).
const toRegex = (pattern) => {
  const anchored = pattern.replace(/\/$/, '').includes('/');
  let p = pattern.replace(/^\//, '');
  if (!anchored) p = '**/' + p;
  if (p.endsWith('/')) p += '**';
  const re = p
    .split(/(\*\*\/|\/\*\*|\*|\?)/)
    .map((t) =>
      t === '**/' ? '(?:.*/)?'
        : t === '/**' ? '/.*'
          : t === '*' ? '[^/]*'
            : t === '?' ? '[^/]'
              : t.replace(/[.+^${}()|[\]\\]/g, '\\$&'),
    )
    .join('');
  return new RegExp(`^${re}(?:/.*)?$`);
};

const parseOwners = (text = '') =>
  text
    .split('\n')
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((l) => {
      const [pattern, ...owners] = l.split(/\s+/);
      return { re: toRegex(pattern), owners };
    });

// Last matching line wins (CODEOWNERS semantics).
const ownersOf = (rules, file) => {
  let hit;
  for (const r of rules) if (r.re.test(file)) hit = r;
  return hit ? hit.owners : [];
};

const botMayApprove = (rules, file, bot) =>
  !HARD_DENY.some((r) => r.test(file)) && ownersOf(rules, file).some((o) => o.toLowerCase() === '@' + bot.toLowerCase());

/**
 * Pure decision.
 * @returns { action: 'approve' | 'wait' | 'skip', reason }
 */
const decide = ({ pr, files, reviews, codeowners, bot }) => {
  const sha = pr.head.sha;
  if (pr.draft) return { action: 'skip', reason: 'draft PR' };
  if (pr.user.login.toLowerCase() === bot.toLowerCase()) return { action: 'skip', reason: 'bot is the PR author' };

  const latestBot = reviews.filter((r) => r.user.login.toLowerCase() === bot.toLowerCase()).at(-1);
  if (latestBot?.state === 'APPROVED' && latestBot.commit_id === sha) return { action: 'skip', reason: 'bot already approved this commit' };

  const rules = parseOwners(codeowners);
  const blocked = files.filter((f) => !botMayApprove(rules, f, bot));
  if (blocked.length) return { action: 'skip', reason: `bot may not approve: ${blocked.join(', ')}` };

  const copilot = reviews.filter((r) => r.user.login === COPILOT && r.commit_id === sha).at(-1);
  if (!copilot) return { action: 'wait', reason: `no Copilot review of ${sha.slice(0, 7)} yet` };
  if (copilot.state !== 'APPROVED') return { action: 'skip', reason: `Copilot review of ${sha.slice(0, 7)} is ${copilot.state}` };
  return { action: 'approve', reason: `Copilot approved ${sha.slice(0, 7)}; bot owns all changed files` };
};

const readCodeowners = async (github, repo, ref) => {
  for (const path of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    try {
      const { data } = await github.rest.repos.getContent({ ...repo, path, ref });
      return Buffer.from(data.content, 'base64').toString('utf8');
    } catch (e) {
      if (e.status !== 404) throw e;
    }
  }
  return '';
};

const evaluate = async (github, repo, pr, ref, bot) => {
  const [changed, reviews, codeowners] = await Promise.all([
    github.paginate(github.rest.pulls.listFiles, { ...repo, pull_number: pr.number, per_page: 100 }),
    github.paginate(github.rest.pulls.listReviews, { ...repo, pull_number: pr.number, per_page: 100 }),
    readCodeowners(github, repo, ref),
  ]);
  const files = [...new Set(changed.flatMap((f) => [f.filename, f.previous_filename].filter(Boolean)))];
  return decide({ pr, files, reviews, codeowners, bot });
};

// The run started by the author's push waits this long for Copilot's review: runs triggered by
// Copilot's review event would be held for manual approval, so we don't listen to it.
const WAIT_MS = 15 * 60_000;
const POLL_MS = 30_000;

/**
 * Entry point for actions/github-script.
 * @param github  octokit with read access (GITHUB_TOKEN)
 * @param botApi  octokit authenticated as the machine user
 */
const run = async ({ github, botApi, context, core }, { waitMs = WAIT_MS, pollMs = POLL_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) => {
  const repo = context.repo;
  const { data: me } = await botApi.rest.users.getAuthenticated();
  const bot = me.login;
  const { data: meta } = await github.rest.repos.get(repo);
  const base = meta.default_branch;

  const number = context.payload.pull_request?.number;
  const prs = number
    ? [(await github.rest.pulls.get({ ...repo, pull_number: number })).data]
    : await github.paginate(github.rest.pulls.list, { ...repo, state: 'open', base, per_page: 100 });

  for (let pr of prs) {
    if (pr.state !== 'open' || pr.base.ref !== base) continue;
    const sha = pr.head.sha;
    let result = await evaluate(github, repo, pr, base, bot);
    // Only a single-PR run (author's push) waits; schedule / workflow_dispatch sweeps don't.
    const deadline = Date.now() + (number ? waitMs : 0);
    while (result.action === 'wait' && Date.now() < deadline) {
      core.info(`#${pr.number}: ${result.reason}; waiting`);
      await sleep(pollMs);
      const { data: fresh } = await github.rest.pulls.get({ ...repo, pull_number: pr.number });
      if (fresh.state !== 'open' || fresh.head.sha !== sha || fresh.base.ref !== base) {
        result = { action: 'skip', reason: 'head moved, base changed or PR closed' };
        break;
      }
      pr = fresh;
      result = await evaluate(github, repo, pr, base, bot);
    }
    core.info(`#${pr.number} ${sha.slice(0, 7)} -> ${result.action}: ${result.reason}`);
    if (result.action !== 'approve') continue;
    await botApi.rest.pulls.createReview({
      ...repo,
      pull_number: pr.number,
      commit_id: sha,
      event: 'APPROVE',
      body: `Approved after Copilot code review approved ${sha.slice(0, 7)}. Scope: files where @${bot} is a code owner.`,
    });
  }
};

module.exports = { run, decide, parseOwners, ownersOf, botMayApprove, toRegex, COPILOT };
