import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {TaskStore} from '../src/store.mjs';
import {WakeStore} from '../src/wake-store.mjs';
import {runWakeCommand} from '../src/event-wake-cli.mjs';

function setup(t) {
  const root=mkdtempSync(path.join(os.tmpdir(),'enigma-wake-cli-'));
  const privateRoot=path.join(root,'private'),stateDir=path.join(privateRoot,'state'),repoPath=path.join(root,'repo');mkdirSync(stateDir,{recursive:true});
  const file=path.join(privateRoot,'config.json'),thread=randomUUID();
  const c={version:1,repoPath,stateDir,worktreesRoot:path.join(privateRoot,'worktrees'),allowedTeamId:'T1',allowedUserIds:['U1'],allowedChannelIds:['CW','CP','CR','CU'],
    bots:[{key:'atlas',role:'atlas',botTokenEnv:'ENIGMA_ATLAS_BOT_TOKEN',appTokenEnv:'ENIGMA_ATLAS_APP_TOKEN'}],
    projects:[{key:'enigma',repoPath,repositoryFullName:'owner/enigma',channelIds:['CW','CP','CR','CU'],channels:{work:'CW',pullRequests:'CP',codeReview:'CR',updates:'CU'}}],untouched:{value:'preserve'}};
  writeFileSync(file,JSON.stringify(c));const tasks=new TaskStore(path.join(stateDir,'tasks.db'));t.after(()=>{
    tasks.close();
    if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir()) || !path.basename(root).startsWith('enigma-wake-cli-'))throw new Error('Invalid disposable directory.');
    rmSync(root,{recursive:true,force:true});
  });
  const command=(name,flag,value)=>runWakeCommand([name,'--config',file,flag,value],{env:{}});
  return {file,thread,c,tasks,command};
}
test('activation preserves private configuration and retains its boundary across repeated enables',t=>{
  const f=setup(t);const result=f.command('enable','--thread',f.thread);assert.equal(result.taskSequenceFloor,0);
  const task=f.tasks.enqueue({eventId:'E1',conversationKey:'T1:CW:1:atlas',role:'atlas',prompt:'test',channel:'CW',slackThreadTs:'1.1',userId:'U1',teamId:'T1',botKey:'atlas'}).task;
  f.tasks.update(task.id,{status:'completed'});
  assert.equal(f.command('enable','--thread',f.thread).taskSequenceFloor,0);
  assert.deepEqual(JSON.parse(readFileSync(f.file,'utf8')).untouched,{value:'preserve'});
  assert.throws(()=>f.command('enable','--thread',randomUUID()),/Existing host task differs/);
});
test('active Slack work prevents activation and leaves config unchanged',t=>{
  const f=setup(t);f.tasks.enqueue({eventId:'E1',conversationKey:'T1:CW:1:atlas',role:'atlas',prompt:'test',channel:'CW',slackThreadTs:'1.1',userId:'U1',teamId:'T1',botKey:'atlas'});
  const before=readFileSync(f.file,'utf8');assert.throws(()=>f.command('enable','--thread',f.thread),/Wait for active/);assert.equal(readFileSync(f.file,'utf8'),before);
});
test('inspect, ack and finish keep delivery separate from processing and survive journal reopen',t=>{
  const f=setup(t);f.command('enable','--thread',f.thread);
  const journal=new WakeStore(path.join(f.c.stateDir,'event-wake.db'),f.thread);const event=journal.add('test',{kind:'task-completed'});journal.attempt(event.id);journal.queued(event.id,randomUUID());journal.close();
  assert.equal(f.command('inspect','--event',event.id).event.status,'queued');
  assert.equal(f.command('finish','--event',event.id).event.status,'queued');
  assert.equal(f.command('ack','--event',event.id).event.status,'acknowledged');
  assert.equal(f.command('finish','--event',event.id).event.status,'handled');
  assert.equal(f.command('ack','--event',event.id).event.status,'handled');
});
