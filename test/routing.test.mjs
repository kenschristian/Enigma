import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../src/service.mjs';
import { validateConfig, redact } from '../src/config.mjs';
import { splitMessage, slackApi, SlackConnection } from '../src/slack.mjs';
import path from 'node:path';
import os from 'node:os';

const config = { version: 1, repoPath: path.join(os.tmpdir(), 'enigma-repo'), stateDir: path.join(os.tmpdir(), 'enigma-state'), worktreesRoot: path.join(os.tmpdir(), 'enigma-trees'), allowedTeamId: 'T123', allowedUserIds: ['U123'], allowedChannelIds: ['C123'], bots: [{ key:'atlas', role:'atlas', botTokenEnv:'ENIGMA_ATLAS_BOT_TOKEN', appTokenEnv:'ENIGMA_ATLAS_APP_TOKEN' }] };
const connection = { bot: config.bots[0], botUserId: 'UBOT' };
const envelope = () => ({ type:'event_callback', event_id:'Ev1', team_id:'T123', event:{type:'app_mention', user:'U123', channel:'C123', ts:'123.456', text:'<@UBOT> nova: fix the button'} });
test('authorized explicit mentions route to the requested specialist', () => {
  const task = routeEvent(envelope(), connection, config);
  assert.equal(task.role, 'frontend'); assert.equal(task.prompt, 'fix the button');
  assert.equal(task.conversationKey, 'T123:C123:123.456:frontend');
});
test('wrong workspace, user, channel, bots and edits cannot run code', () => {
  for (const patch of [{user:'UOTHER'}, {channel:'COTHER'}, {bot_id:'B1'}, {subtype:'message_changed'}, {type:'message'}, {text:'not mentioned'}, {team:'TOTHER'}, {thread_ts:'bad'}]) {
    const p = envelope(); Object.assign(p.event, patch); assert.equal(routeEvent(p, connection, config), null);
  }
  const p = envelope(); p.team_id = 'TOTHER'; assert.equal(routeEvent(p, connection, config), null);
});
test('dedicated bots keep their assigned role', () => assert.equal(routeEvent(envelope(), { ...connection, bot:{...connection.bot,role:'backend'} }, config).role, 'backend'));
test('config denies empty access lists, unsafe paths, duplicate bots and missing credentials', () => {
  assert.equal(validateConfig(config,{requireTokens:false,env:{}}).maxConcurrent,1);
  for (const patch of [{allowedUserIds:[]}, {allowedChannelIds:['*']}, {allowedTeamId:'evil'}, {stateDir:config.repoPath}, {maxConcurrent:4}, {bots:[config.bots[0],config.bots[0]]}]) assert.throws(()=>validateConfig({...config,...patch},{requireTokens:false,env:{}}));
  assert.throws(()=>validateConfig(config,{env:{}}),/credentials are missing/);
});
test('messages split without corrupting unicode and credentials are redacted', () => {
  const text = '👍'.repeat(8000); const parts = splitMessage(text);
  assert.equal(parts.join(''), text); assert.equal(parts.length,3);
  assert.equal(redact('xoxb-123-abcdef',{}),'[redacted]');
});
test('Slack errors are sanitized and rate limits retain retry information', async () => {
  await assert.rejects(slackApi('auth.test','secret',{}, {fetchFn:async()=>{throw new Error('secret');}}), e=>e.message==='Slack: connection_failed');
  await assert.rejects(slackApi('auth.test','secret',{}, {fetchFn:async()=>({status:429,headers:new Headers({'retry-after':'60'})})}),e=>e.retryAfter===60);
});
test('Slack bot identity must match configured workspace', async () => {
  const c = new SlackConnection({bot:config.bots[0],teamId:'T123',env:{},api:async()=>({ok:true,team_id:'TOTHER',user_id:'UBOT',bot_id:'B1'})});
  await assert.rejects(c.verify(),/wrong_workspace/);
});
