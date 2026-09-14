import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { TaskStore } from '../src/store.mjs';
import { WakeStore } from '../src/wake-store.mjs';
import { EventWakeController,hostWakeMessage } from '../src/event-wake.mjs';
import { projectIdentity } from '../src/projects.mjs';
import { validateConfig } from '../src/config.mjs';

const host=randomUUID(), repo=path.join(os.tmpdir(),'wake-repo');
const config=()=>({version:1,repoPath:repo,stateDir:path.join(os.tmpdir(),'wake-private','state'),worktreesRoot:path.join(os.tmpdir(),'wake-private','worktrees'),
  allowedTeamId:'T1',allowedUserIds:['U1'],allowedChannelIds:['CW','CP','CR','CU'],codexCommand:'codex',
  bots:[{key:'atlas',role:'atlas',botTokenEnv:'ENIGMA_ATLAS_BOT_TOKEN',appTokenEnv:'ENIGMA_ATLAS_APP_TOKEN'}],
  projects:[{key:'enigma',repoPath:repo,repositoryFullName:'owner/Enigma',channelIds:['CW','CP','CR','CU'],channels:{work:'CW',pullRequests:'CP',codeReview:'CR',updates:'CU'}}],
  eventWake:{enabled:true,threadId:host,taskSequenceFloor:0,githubPollSeconds:30}});
function fixture(options={}) {
  const c=config(), store=new TaskStore(':memory:'), journal=new WakeStore(':memory:',host), calls=[],notices=[];
  const controller=new EventWakeController({config:c,configFile:path.join(os.tmpdir(),'wake-private','config.json'),store,journal,
    checkConfig:()=>true,readLedger:async()=>({entries:[]}),now:()=>100,
    enqueue:async p=>{calls.push(p); return {status:'queued',queuedSubmissionId:randomUUID()};},notice:(event,text)=>notices.push({event,text}),...options});
  const add=(patch={})=> {
    const {task}=store.enqueue({eventId:randomUUID(),conversationKey:`T1:CW:${randomUUID()}:atlas`,role:'atlas',prompt:'Make the authorized change',
      channel:'CW',slackThreadTs:'1.1',userId:'U1',teamId:'T1',botKey:'atlas',projectIdentity:projectIdentity(c,'CW'),...patch});
    return store.update(task.id,{status:'completed'});
  };
  return {c,store,journal,controller,calls,notices,add,close:async()=>{await controller.stop();store.close();}};
}

test('idle cycles and help controls make no host queue calls',async()=>{
  const f=fixture(); f.add({conversationKey:'T1:CW:1:atlas:control'});
  await f.controller.tick();await f.controller.tick();assert.equal(f.calls.length,0);await f.close();
});
test('new completed authorized work queues once; queued is not acknowledged delivery',async()=>{
  const f=fixture();const task=f.add();await f.controller.tick();await f.controller.tick();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].threadId,host);
  const event=f.journal.get(f.calls[0].eventId);assert.equal(event.payload.taskId,task.id);assert.equal(event.status,'queued');
  assert.equal(event.payload.prompt,undefined);assert.equal(f.calls[0].message.includes(task.prompt),false);await f.close();
});
test('activation boundary excludes historical tasks; new tasks still wake',async()=>{
  const f=fixture();f.add();f.c.eventWake.taskSequenceFloor=1;f.add();await f.controller.tick();assert.equal(f.calls.length,1);await f.close();
});
test('unauthorized, remapped, interrupted and superseded tasks cannot wake host',async()=>{
  const f=fixture();f.add({userId:'U2'});f.add({channel:'CR'});f.add({projectIdentity:'wrong'});
  const interrupted=f.add();f.store.update(interrupted.id,{status:'interrupted'});
  const previous=f.add();const followup=f.add({conversationKey:previous.conversationKey});f.store.update(followup.id,{status:'queued'});
  await f.controller.tick();assert.equal(f.calls.length,0);await f.close();
});
test('dispatch rechecks renewed conversation activity after discovery',async()=>{
  const f=fixture();const task=f.add();f.controller.discoverTasks();
  const newer=f.add({conversationKey:task.conversationKey});f.store.update(newer.id,{status:'queued'});
  await f.controller.dispatch();assert.equal(f.calls.length,0);assert.equal(f.notices.length,0);await f.close();
});
test('crash after persisted attempt reconciles without repeating add',async()=>{
  const f=fixture();f.add();f.controller.discoverTasks();const event=f.journal.pending()[0];f.journal.attempt(event.id);
  await f.controller.dispatch();assert.equal(f.calls.length,1);assert.equal(f.calls[0].reconcileOnly,true);await f.close();
});
test('uncertain queue delivery blocks with one durable notice, never an AI retry loop',async()=>{
  let calls=0;const f=fixture({enqueue:async()=>{calls++;return {status:'uncertain'};}});f.add();
  await f.controller.tick();await f.controller.tick();assert.equal(calls,1);assert.equal(f.notices.length,1);await f.close();
});
test('host acknowledgement racing queue response is preserved and finish is explicit',async()=>{
  const f=fixture();f.controller.enqueue=async p=>{f.journal.acknowledge(p.eventId);return{status:'queued',queuedSubmissionId:randomUUID()};};
  f.add();await f.controller.tick();const row=f.journal.db.prepare('SELECT id,status FROM wake_events').get();
  assert.equal(row.status,'acknowledged');assert.equal(f.journal.finish(row.id).status,'handled');await f.close();
});
test('GitHub watches only mapped open ledger entries and deduplicates unchanged evidence',async()=>{
  let now=100,reads=0;const f=fixture({now:()=>now,readLedger:async()=>({entries:[
    {repository:'owner/Enigma',pullRequest:5,initialReview:{id:'check:123'}},
    {repository:'outside/repo',pullRequest:7},{repository:'owner/Enigma',pullRequest:4,confirmedMerge:{commit:'abc'}}]}),
    observe:async input=>{reads++;assert.equal(input.reviewRecorded,true);return{repository:'owner/enigma',pullRequest:5,actionKey:'a'.repeat(64)};}});
  await f.controller.tick();await f.controller.tick();assert.equal(reads,1);assert.equal(f.calls.length,1);
  now+=30000;await f.controller.tick();assert.equal(reads,2);assert.equal(f.calls.length,1);await f.close();
});
test('GitHub outages wake once and contain no raw error or credentials',async()=>{
  let now=100;const f=fixture({now:()=>now,readLedger:async()=>({entries:[{repository:'owner/Enigma',pullRequest:5}]}),observe:async()=>{throw new Error('secret-token');}});
  await f.controller.tick();now+=30000;await f.controller.tick();assert.equal(f.calls.length,1);assert.ok(!f.calls[0].message.includes('secret-token'));await f.close();
});
test('unavailable review ledger cannot strand a completed Slack task handoff',async()=>{
  const f=fixture({readLedger:async()=>{throw new Error('unavailable');}});f.add();await f.controller.tick();assert.equal(f.calls.length,1);await f.close();
});
test('changed private mappings stop event delivery without widening permissions',async()=>{
  const f=fixture({checkConfig:()=>false});f.add();await f.controller.tick();assert.equal(f.calls.length,0);assert.equal(f.controller.stopping,true);await f.close();
});
test('revocation during review observation prevents the subsequent task dispatch',async()=>{
  let allowed=true;const f=fixture({checkConfig:()=>allowed,readLedger:async()=>{allowed=false;return{entries:[]};}});
  f.add();await f.controller.tick();assert.equal(f.calls.length,0);assert.equal(f.controller.stopping,true);await f.close();
});
test('revocation between deliveries prevents the next queued event and its notice',async()=>{
  let allowed=true,calls=0;const f=fixture({checkConfig:()=>allowed,enqueue:async()=>{calls++;allowed=false;return{status:'uncertain'};}});
  f.add();f.add();await f.controller.tick();assert.equal(calls,1);assert.equal(f.notices.length,0);await f.close();
});
test('host prompt has explicit acknowledgement, human Merge and no idle heartbeat',()=>{
  const message=hostWakeMessage({id:randomUUID()},path.join(os.tmpdir(),'config.json'));
  assert.match(message,/inspect --config/);assert.match(message,/ack instead/);assert.match(message,/Keep the desktop heartbeat paused/);assert.match(message,/Never merge/);
});

test('Devin preparation and selection never create host wake events, even without control suffix',async()=>{
  const f=fixture();f.add({kind:'devin-prompt'});f.add({kind:'devin-selection'});
  await f.controller.tick();assert.equal(f.calls.length,0);assert.equal(f.journal.pending().length,0);await f.close();
});

test('discovered task wake is invalidated by noncoding kind or Devin thread ownership',async()=>{
  for(const change of ['kind','owner']) {
    const f=fixture();const task=f.add();f.controller.discoverTasks();
    if(change==='kind') {
      task.kind='devin-prompt';f.store.db.prepare('UPDATE tasks SET data=? WHERE id=?').run(JSON.stringify(task),task.id);
    } else {
      f.store.db.prepare('UPDATE thread_executors SET data=?').run(JSON.stringify({executor:'devin',projectIdentity:task.projectIdentity}));
    }
    await f.controller.dispatch();assert.equal(f.calls.length,0);assert.equal(f.notices.length,0);await f.close();
  }
});

test('Devin review ledger entries never observe GitHub or wake Codex',async()=>{
  let reads=0;const f=fixture({readLedger:async()=>({entries:[{repository:'owner/Enigma',pullRequest:5,executor:'devin'}]}),
    observe:async()=>{reads++;throw new Error('Must not observe');}});
  await f.controller.tick();assert.equal(reads,0);assert.equal(f.calls.length,0);await f.close();
});

test('pending GitHub wake revalidates an executor changed to Devin before dispatch',async()=>{
  const entry={repository:'owner/Enigma',pullRequest:5};
  const f=fixture({readLedger:async()=>({entries:[entry]}),
    observe:async()=>({repository:'owner/Enigma',pullRequest:5,actionKey:'a'.repeat(64)})});
  await f.controller.discoverReviews();assert.equal(f.journal.pending().length,1);
  entry.executor='devin';await f.controller.dispatch();
  assert.equal(f.calls.length,0);assert.equal(f.notices.length,0);await f.close();
});

test('unavailable review ownership leaves its wake pending while an independent task still dispatches',async()=>{
  const f=fixture({readLedger:async()=>({entries:[{repository:'owner/Enigma',pullRequest:5}]}),
    observe:async()=>({repository:'owner/Enigma',pullRequest:5,actionKey:'a'.repeat(64)})});
  await f.controller.discoverReviews();f.add();f.controller.discoverTasks();
  f.controller.readLedger=async()=>{throw new Error('temporarily unavailable');};
  await f.controller.dispatch();
  assert.equal(f.calls.length,1);assert.equal(f.journal.get(f.calls[0].eventId).payload.kind,'task-completed');
  assert.equal(f.journal.pending().length,1);await f.close();
});
test('enabled configuration requires an explicit host, activation fence, projects and channels',()=>{
  const valid=value=>validateConfig(value,{env:{},requireTokens:false});assert.equal(valid(config()).eventWake.enabled,true);
  for(const patch of [{threadId:'unknown'},{taskSequenceFloor:-1},{githubPollSeconds:1}])assert.throws(()=>valid({...config(),eventWake:{...config().eventWake,...patch}}));
  const c=config();c.projects[0].channels.updates='CW';assert.throws(()=>valid(c));
});
