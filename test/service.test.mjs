import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TaskStore } from '../src/store.mjs';
import { AgentService } from '../src/service.mjs';

const config = {allowedTeamId:'T1',allowedUserIds:['U1'],allowedChannelIds:['C1'],maxConcurrent:1,taskTimeoutMinutes:1};
const connection = {bot:{key:'atlas',role:'atlas'},botUserId:'UBOT'};
const event = (id, text, thread='1.1', user='U1') => ({type:'event_callback',team_id:'T1',event_id:id,event:{type:'app_mention',user,channel:'C1',text:`<@UBOT> ${text}`,ts:`${id.replace(/\D/g,'')||1}.1`,thread_ts:thread}});
function fixture(options = {}) {
  const store = new TaskStore(':memory:');
  const calls = [];
  const service = new AgentService({ config:{...config,...options.config},store,
    worktrees:{ensure:async key=>({path:`C:/work/${key}`,branch:'codex/test'})},
    clientFactory:options.clientFactory || (()=>({start:async()=>{},close:async()=>{},run:async params=>{calls.push(params);await params.onThread('thread-1');return {status:'completed',text:'Done',threadId:'thread-1'};}})),
    connections:options.connections || new Map() });
  return {store,service,calls};
}
async function drained(service) { while(service.active.size) await Promise.allSettled([...service.active.values()].map(a=>a.promise)); }

test('duplicate Slack deliveries launch one task and thread resumes on later mention',async()=>{
  const {store,service,calls}=fixture();
  assert.equal(service.receive(event('E1','fix it'),connection),true);
  service.receive(event('E1','fix it'),connection);
  service.pump();await drained(service);
  assert.equal(calls.length,1);assert.equal(calls[0].effort,'ultra');
  service.receive(event('E2','now test it'),connection);service.pump();await drained(service);
  assert.equal(calls.length,2);assert.equal(calls[1].threadId,'thread-1');
  assert.equal(store.list()[0].status,'completed');store.close();
});
test('controls never consume model calls and unauthorized senders cannot query status',async()=>{
  const {store,service,calls}=fixture();
  service.receive(event('E1','help'),connection);service.receive(event('E2','status'),connection);
  assert.equal(service.receive(event('E3','status','1.1','UOTHER'),connection),false);
  service.pump();await drained(service);assert.equal(calls.length,0);store.close();
});
test('same conversation serializes while unrelated tasks run concurrently',async()=>{
  const resolvers=[];const starts=[];
  const {store,service}=fixture({config:{maxConcurrent:2},clientFactory:()=>({start:async()=>{},close:async()=>{},run:async p=>{starts.push(p);return new Promise(r=>resolvers.push(r));}})});
  service.receive(event('E1','one'),connection);service.receive(event('E2','two'),connection);service.receive(event('E3','three','3.1'),connection);
  service.pump();await delay(5);assert.equal(starts.length,2);
  resolvers.splice(0).forEach(r=>r({status:'completed',text:'done'}));await drained(service);
  service.pump();await delay(5);assert.equal(starts.length,3);resolvers[0]({status:'completed',text:'done'});await drained(service);store.close();
});
test('restart marks running work interrupted and pauses follow-ups until explicit resume',async()=>{
  const {store,service,calls}=fixture();
  service.receive(event('E1','one'),connection);const original=store.list()[0];store.update(original.id,{status:'running',codexThreadId:'saved-thread'});
  service.receive(event('E2','two'),connection);
  service.start();await delay(5);
  assert.equal(store.get(original.id).status,'interrupted');assert.equal(calls.length,0);
  assert.equal(store.list().find(t=>t.eventId==='atlas:E2').status,'cancelled');
  service.receive(event('E3',`resume ${original.id}`),connection);service.pump();await drained(service);
  assert.equal(calls.length,1);assert.equal(calls[0].threadId,'saved-thread');
  await service.stop();store.close();
});
test('cancel preserves files and prevents another turn until client cleanup finishes',async()=>{
  let cleanup;let entered=false;
  const {store,service}=fixture({config:{maxConcurrent:2},clientFactory:()=>({start:async()=>{},run:async p=>{entered=true;return new Promise((_,reject)=>p.signal.addEventListener('abort',()=>reject(new Error('cancelled'))));},close:()=>new Promise(r=>{cleanup=r;})})});
  service.receive(event('E1','one'),connection);const task=store.list()[0];service.pump();await delay(5);assert.ok(entered);
  service.receive(event('E2',`cancel ${task.id}`),connection);await delay(5);
  service.receive(event('E3','next'),connection);service.pump();
  assert.equal(service.active.size,1);assert.equal(store.get(task.id).status,'cancelled');
  cleanup();await drained(service);store.close();
});
test('synchronous client construction failure is stored and does not strand running state',async()=>{
  const {store,service}=fixture({clientFactory:()=>{throw new Error('secret');}});
  service.receive(event('E1','one'),connection);service.pump();await drained(service);
  assert.equal(store.list()[0].status,'failed');assert.equal(store.list()[0].error,'TASK_FAILED');store.close();
});
test('denied approval followed by failure leaves recoverable interrupted work',async()=>{
  const {store,service}=fixture({clientFactory:()=>({start:async()=>{},close:async()=>{},run:async p=>{p.onApproval({});throw new Error('private raw error');}})});
  service.receive(event('E1','one'),connection);service.pump();await drained(service);
  assert.equal(store.list()[0].status,'interrupted');assert.equal(store.list()[0].error,'TASK_FAILED');store.close();
});
test('results are saved before delivery and failed delivery retries without rerunning Codex',async()=>{
  const {store,service,calls}=fixture({connections:new Map([['atlas',{post:async()=>{throw new Error('network');}}]])});
  service.receive(event('E1','one'),connection);service.pump();await drained(service);
  assert.equal(store.list()[0].result,'Done');await service.flush();service.pump();await drained(service);
  assert.equal(calls.length,1);assert.equal(store.list()[0].status,'completed');store.close();
});
