import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackConnection } from '../src/slack.mjs';

function fixture(allowedUserIds = []) {
  const calls = [];
  const connection = new SlackConnection({
    bot: { key: 'atlas', botTokenEnv: 'ENIGMA_ATLAS_BOT_TOKEN', appTokenEnv: 'ENIGMA_ATLAS_APP_TOKEN' },
    teamId: 'T123', allowedUserIds, env: {},
    api: async (method, token, body) => { calls.push({ method, body }); return { ok: true }; },
  });
  return { connection, calls };
}

test('explicit allowlisted notification adds one controlled mention and escapes all body markup', async () => {
  const { connection, calls } = fixture(['UOWNER']);
  await connection.post({ channel: 'CREVIEW', id: 'message-id', threadTs: '123.456', notifyUserId: 'UOWNER',
    text: 'Model says <@UOTHER> <!channel> <!here> @channel @here &lt;@UOTHER&gt; <https://example.test|click> & done' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'chat.postMessage');
  const body = calls[0].body;
  assert.equal(body.mrkdwn, true);
  assert.equal(body.parse, 'none');
  assert.equal(body.link_names, false);
  assert.equal(body.thread_ts, '123.456');
  assert.equal(body.client_msg_id, 'message-id');
  assert.equal(body.text, '<@UOWNER>\nModel says &lt;@UOTHER&gt; &lt;!channel&gt; &lt;!here&gt; @channel @here &amp;lt;@UOTHER&amp;gt; &lt;https://example.test|click&gt; &amp; done');
  assert.equal((body.text.match(/<@/g) || []).length, 1);
  assert.equal(body.unfurl_links, false);
  assert.equal(body.unfurl_media, false);
});

test('unknown or invalid notification recipients fail before any API request', async () => {
  const { connection, calls } = fixture(['UOWNER', '<!channel>']);
  for (const notifyUserId of ['UOTHER', '<!channel>', '', 123, 'UOWNER>\n<!here>']) {
    await assert.rejects(connection.post({ channel: 'CREVIEW', text: 'Notice', notifyUserId }), /notification_user_not_allowed/);
  }
  assert.equal(calls.length, 0);
  const noAllowlist = fixture();
  await assert.rejects(noAllowlist.connection.post({ channel: 'CREVIEW', text: 'Notice', notifyUserId: 'UOWNER' }), /notification_user_not_allowed/);
  assert.equal(noAllowlist.calls.length, 0);
});

test('ordinary replies remain plain text with mention parsing disabled', async () => {
  const { connection, calls } = fixture(['UOWNER']);
  const text = '<@UOWNER> <!channel> & content';
  await connection.post({ channel: 'CREVIEW', text });
  assert.equal(calls[0].body.text, text);
  assert.equal(calls[0].body.mrkdwn, false);
  assert.equal(calls[0].body.parse, 'none');
  assert.equal(calls[0].body.link_names, false);
});

test('notification allowlist is copied rather than changed by caller array mutation', async () => {
  const allowed = ['UOWNER'];
  const { connection, calls } = fixture(allowed);
  allowed.push('UOTHER');
  await assert.rejects(connection.post({ channel: 'CREVIEW', text: 'Notice', notifyUserId: 'UOTHER' }), /notification_user_not_allowed/);
  assert.equal(calls.length, 0);
});

test('validated PR link enables one controlled link with or without an owner mention', async () => {
  const { connection, calls } = fixture(['UOWNER']);
  const prUrl = 'https://github.com/owner/repo/pull/12';
  const text = 'Review <@UOTHER> <!channel> <https://example.test|bad> & done';
  await connection.post({ channel: 'CREVIEW', text, prUrl });
  await connection.post({ channel: 'CREVIEW', text, prUrl, notifyUserId: 'UOWNER' });
  for (const { body } of calls) {
    assert.equal(body.mrkdwn, true);
    assert.equal(body.parse, 'none');
    assert.equal(body.link_names, false);
    assert.ok(body.text.endsWith(`\n\n<${prUrl}|Open pull request>`));
    assert.match(body.text, /&lt;@UOTHER&gt; &lt;!channel&gt; &lt;https:\/\/example.test\|bad&gt; &amp; done/);
    assert.equal((body.text.match(/<https:/g) || []).length, 1);
  }
  assert.equal(calls[0].body.text.includes('<@'), false);
  assert.ok(calls[1].body.text.startsWith('<@UOWNER>\n'));
});

test('unsafe PR URLs fail before the Slack API request', async () => {
  const { connection, calls } = fixture(['UOWNER']);
  const unsafe = [
    'http://github.com/owner/repo/pull/1', 'https://github.com.evil.test/owner/repo/pull/1',
    'https://secret@github.com/owner/repo/pull/1', 'https://github.com/owner/repo/pull/1?token=secret',
    'https://github.com/owner/repo/pull/1#comment', 'https://github.com/owner/../pull/1',
    'https://github.com/owner/repo/pull/1\n', 'https://github.com/owner/repo/pull/1|click><!channel>',
    '', 123,
  ];
  for (const prUrl of unsafe) {
    await assert.rejects(connection.post({ channel: 'CREVIEW', text: 'Notice', notifyUserId: 'UOWNER', prUrl }), /invalid_pull_request_url/);
  }
  assert.equal(calls.length, 0);
});
