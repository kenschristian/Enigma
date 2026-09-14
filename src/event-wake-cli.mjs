import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFileSync,lstatSync,writeFileSync,renameSync,unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { validateConfig } from './config.mjs';
import { WakeStore,uuid } from './wake-store.mjs';

function regular(file) {
  let first=true;
  for(let part=path.resolve(file);;part=path.dirname(part)) {
    const stat=lstatSync(part);
    if(stat.isSymbolicLink() || (first?!stat.isFile():!stat.isDirectory())) throw new Error('Use a regular private configuration path.');
    if(part===path.dirname(part)) break;
    first=false;
  }
}

export function runWakeCommand(args,{env=process.env}={}) {
  const [command,...rest]=args;
  if(!['enable','inspect','ack','finish'].includes(command) || rest.length%2) throw new Error('Use enable, inspect, ack or finish with --config and --thread/--event.');
  const flags={};
  for(let i=0;i<rest.length;i+=2) {
    if(!['--config','--thread','--event'].includes(rest[i]) || flags[rest[i]]!==undefined) throw new Error('Invalid command options.');
    flags[rest[i]]=rest[i+1];
  }
  const file=flags['--config'];
  if(typeof file!=='string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) throw new Error('Supply the absolute private configuration path.');
  regular(file);
  const raw=JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
  const config=validateConfig(raw,{env,requireTokens:false});
  // Host activation must operate alongside the validated private state, never in a repository/cloud folder.
  if(path.dirname(file)!==path.dirname(config.stateDir)) throw new Error('Configuration must be beside the private state folder.');
  if(command==='enable') {
    if(!uuid(flags['--thread']) || flags['--event']) throw new Error('Enable requires only --config and --thread UUID.');
    let floor=raw.eventWake?.taskSequenceFloor;
    if(raw.eventWake?.threadId && raw.eventWake.threadId!==flags['--thread']) throw new Error('Existing host task differs; review its journal before changing destinations.');
    const db=new DatabaseSync(path.join(config.stateDir,'tasks.db'),{readOnly:true});
    try {
      if(db.prepare("SELECT 1 FROM tasks WHERE status IN ('queued','running') LIMIT 1").get()) throw new Error('Wait for active Slack work before activation.');
      floor ??= db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM tasks').get().value;
    } finally {db.close();}
    raw.eventWake={enabled:true,threadId:flags['--thread'],taskSequenceFloor:floor,githubPollSeconds:60};
    validateConfig(raw,{env,requireTokens:false});
    const journal=new WakeStore(path.join(config.stateDir,'event-wake.db'),flags['--thread']); journal.close();
    const temporary=`${file}.${randomUUID()}.tmp`;
    try {writeFileSync(temporary,JSON.stringify(raw,null,2)+'\n',{flag:'wx',mode:0o600}); renameSync(temporary,file);}
    finally {try{unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw error;}}
    return {enabled:true,threadId:flags['--thread'],taskSequenceFloor:floor,restartRequired:true};
  }
  if(flags['--thread'] || !uuid(flags['--event']) || !config.eventWake?.enabled) throw new Error('Supply an event UUID from this enabled host workflow.');
  const journal=new WakeStore(path.join(config.stateDir,'event-wake.db'),config.eventWake.threadId);
  try {
    const event=command==='ack'?journal.acknowledge(flags['--event']):command==='finish'?journal.finish(flags['--event']):journal.get(flags['--event']);
    if(!event)throw new Error('Wake event not found.');
    return {hostThreadId:config.eventWake.threadId,event};
  } finally {journal.close();}
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {console.log(JSON.stringify(runWakeCommand(process.argv.slice(2))));}
  catch {console.error('Event wake command failed. Check the private config, event ID, host mapping and active task state.');process.exitCode=1;}
}
