// Run: node --test .github/machine-user-approval/approve.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { decide, run, COPILOT } = require('./approve.js');

const BOT = 'venetrius-review-bot';
const CODEOWNERS = `
*          @alice
/backend/  @acme/backend @${BOT}
/client/   @acme/frontend
`;
const SHA = 'head';
const pr = (extra = {}) => ({ number: 1, state: 'open', draft: false, base: { ref: 'main' }, head: { sha: SHA }, user: { login: 'author' }, ...extra });
const review = (login, state, commit_id = SHA) => ({ user: { login }, state, commit_id });
const copilot = (state, sha) => review(COPILOT, state, sha);
const d = (files, reviews, extra = {}) => decide({ pr: pr(extra), files, reviews, codeowners: CODEOWNERS, bot: BOT });

test('approves when Copilot approved the head commit and the bot owns every file', () => {
  assert.equal(d(['backend/A.java'], [copilot('APPROVED')]).action, 'approve');
});

test('waits for a Copilot review of the head commit', () => {
  assert.equal(d(['backend/A.java'], []).action, 'wait');
  assert.equal(d(['backend/A.java'], [copilot('APPROVED', 'old')]).action, 'wait');
});

test('skips when Copilot did not approve the head commit', () => {
  assert.equal(d(['backend/A.java'], [copilot('COMMENTED')]).action, 'skip');
  assert.equal(d(['backend/A.java'], [copilot('APPROVED'), copilot('CHANGES_REQUESTED')]).action, 'skip');
});

test('skips files the bot does not own, without waiting', () => {
  assert.match(d(['backend/A.java', 'README.md'], []).reason, /README\.md/);
  assert.equal(d(['client/src/App.tsx'], [copilot('APPROVED')]).action, 'skip');
  assert.equal(d(['pom.xml'], [copilot('APPROVED')]).action, 'skip');
});

test('hard-denied paths are never approvable, even if CODEOWNERS lists the bot', () => {
  const codeowners = `* @${BOT}`;
  for (const f of ['.github/workflows/ci.yml', 'CODEOWNERS', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'REVIEW.md', 'README.md', '.claude/skills/x/SKILL.md', '.agents/skills/x/SKILL.md']) {
    assert.equal(decide({ pr: pr(), files: [f], reviews: [copilot('APPROVED')], codeowners, bot: BOT }).action, 'skip', f);
  }
  assert.equal(decide({ pr: pr(), files: ['docs/x.md'], reviews: [copilot('APPROVED')], codeowners, bot: BOT }).action, 'approve');
});

test('never approves its own PR', () => {
  assert.match(d(['backend/A.java'], [copilot('APPROVED')], { user: { login: 'Venetrius-Review-Bot' } }).reason, /author/);
});

test('skips drafts and commits it already approved', () => {
  assert.equal(d(['backend/A.java'], [copilot('APPROVED')], { draft: true }).action, 'skip');
  assert.equal(d(['backend/A.java'], [copilot('APPROVED'), review(BOT, 'APPROVED')]).action, 'skip');
  assert.equal(d(['backend/A.java'], [copilot('APPROVED'), review(BOT, 'APPROVED', 'old')]).action, 'approve');
});

const fakeApi = ({ files, reviewsSeq, heads = [] }) => {
  const created = [];
  let call = 0;
  const github = {
    paginate: async (fn, args) => fn(args),
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: 'main' } }),
        getContent: async () => ({ data: { content: Buffer.from(CODEOWNERS).toString('base64') } }),
      },
      pulls: {
        get: async () => ({ data: pr({ head: { sha: heads.shift() ?? SHA } }) }),
        list: async () => [pr()],
        listFiles: async () => files.map((filename) => ({ filename })),
        listReviews: async () => reviewsSeq[Math.min(call++, reviewsSeq.length - 1)],
      },
    },
  };
  const botApi = {
    rest: {
      users: { getAuthenticated: async () => ({ data: { login: BOT } }) },
      pulls: { createReview: async (args) => created.push(args) },
    },
  };
  return { github, botApi, created };
};
const ctx = (payload) => ({ repo: { owner: 'o', repo: 'r' }, payload });
const core = { info: () => {} };
const opts = { waitMs: 1000, pollMs: 1, sleep: async () => {} };

test('run: push-triggered run waits for Copilot, then approves as the bot', async () => {
  const api = fakeApi({ files: ['backend/A.java'], reviewsSeq: [[], [], [copilot('APPROVED')]] });
  await run({ ...api, context: ctx({ pull_request: { number: 1 } }), core }, opts);
  assert.equal(api.created.length, 1);
  assert.equal(api.created[0].event, 'APPROVE');
  assert.equal(api.created[0].commit_id, SHA);
});

test('run: stops waiting when the head moves', async () => {
  const api = fakeApi({ files: ['backend/A.java'], reviewsSeq: [[], [copilot('APPROVED')]], heads: [SHA, 'newer'] });
  await run({ ...api, context: ctx({ pull_request: { number: 1 } }), core }, opts);
  assert.equal(api.created.length, 0);
});

test('run: scheduled sweep does not wait', async () => {
  const api = fakeApi({ files: ['backend/A.java'], reviewsSeq: [[], [copilot('APPROVED')]] });
  await run({ ...api, context: ctx({}), core }, opts);
  assert.equal(api.created.length, 0);
});
