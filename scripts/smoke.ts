import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { OpenCode } from '@opencode/client'

const binary = process.env.OPENCODE_BINARY ?? 'opencode'
const versionProcess = Bun.spawn([binary, '--version'], {stdout:'pipe', stderr:'pipe'})
const [versionOutput, versionError, versionExit] = await Promise.all([new Response(versionProcess.stdout).text(), new Response(versionProcess.stderr).text(), versionProcess.exited])
if (versionExit !== 0) throw new Error('Could not read OpenCode version: ' + versionError)
const version = versionOutput.trim()
const root = await mkdtemp(join(tmpdir(), 'opencode-native-wait-'))
const project = join(root, 'project'), configDir = join(root, 'config/opencode')
await mkdir(project, {recursive:true}); await mkdir(configDir, {recursive:true})
const requests:any[] = [], gates = new Map<string,()=>void>()
let logs='', parentCalls=0, idleParentCalls=0
const scenarioSteps=new Map<string,number>()
function assert(value:unknown, message:string):asserts value { if(!value) throw new Error(message) }
async function until<T>(fn:()=>Promise<T|undefined>, ms=25000):Promise<T> {
  const end=Date.now()+ms
  while(Date.now()<end) { const value=await fn(); if(value!==undefined)return value; await Bun.sleep(25) }
  throw new Error('Timed out\n'+logs.slice(-3500))
}
function response(body:any, message:any, finish:string) {
  const id='chatcmpl-'+crypto.randomUUID()
  const usage={prompt_tokens:100,completion_tokens:20,total_tokens:120}
  if(!body.stream)return Response.json({id,object:'chat.completion',model:'test',choices:[{index:0,message,finish_reason:finish}],usage})
  const delta={...message, ...(message.tool_calls?{tool_calls:message.tool_calls.map((t:any,index:number)=>({index,...t}))}:{})}
  const chunks=[{id,object:'chat.completion.chunk',model:'test',choices:[{index:0,delta,finish_reason:null}]},{id,object:'chat.completion.chunk',model:'test',choices:[{index:0,delta:{},finish_reason:finish}],usage}]
  return new Response(chunks.map(x=>'data: '+JSON.stringify(x)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
}
const call=(tag:string, background:boolean)=>({id:'call-'+tag,type:'function',function:{name:'subagent',arguments:JSON.stringify({agent:'probechild',description:tag,prompt:'CHILD_'+tag,background})}})
const model=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req){
  const body=await req.json() as any
  const child=body.messages?.some((m:any)=>m.role==='user' && JSON.stringify(m.content).includes('You are a subagent spawned by another session.'))
  const name=child ? [...body.messages].reverse().filter((m:any)=>m.role==='user').map((m:any)=>JSON.stringify(m.content).match(/CHILD_([A-Z0-9]+)/)?.[1]).find(Boolean) : undefined
  requests.push({name:name??'parent',body,time:Date.now()})
  await writeFile(join(root,'requests.json'),JSON.stringify(requests,null,2))
  if(name){
    await new Promise<void>(resolve=>gates.set(name,resolve))
    if(name==='FAIL'||name==='ERR')return Response.json({error:{message:'Deliberate fixture failure'}},{status:400})
    return response(body,{role:'assistant',content:'RESULT_'+name},'stop')
  }
  if(body.messages?.some((m:any)=>m.role==='user'&&JSON.stringify(m.content).includes('IDLE_PARENT'))){
    idleParentCalls++
    if(idleParentCalls===1)return response(body,{role:'assistant',tool_calls:[call('IDLE',true)]},'tool_calls')
    return response(body,{role:'assistant',content:'IDLE_PARENT_FINISHED'},'stop')
  }
  const scenario=body.messages?.filter((m:any)=>m.role==='user').map((m:any)=>JSON.stringify(m.content).match(/CASE_([a-z]+)/)?.[1]).find(Boolean)
  if(scenario){
    const step=(scenarioSteps.get(scenario)??0)+1;scenarioSteps.set(scenario,step)
    const tags:Record<string,string>={early:'EARLY',timeout:'TIMEOUT',cancel:'CANCELWAIT',error:'ERR',reuse:'REUSE1'}
    if(step===1)return response(body,{role:'assistant',tool_calls:[call(tags[scenario],true)]},'tool_calls')
    const text=body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content).join(' ')
    const ids=[...new Set([...text.matchAll(/sessionID: (ses_[A-Za-z0-9]+)/g)].map(m=>m[1]))]
    if(scenario==='reuse'&&step===3){
      return response(body,{role:'assistant',tool_calls:[{id:'reuse-second',type:'function',function:{name:'subagent',arguments:JSON.stringify({agent:'probechild',description:'reuse second',prompt:'CHILD_REUSE2',sessionID:ids[0],background:true})}}]},'tool_calls')
    }
    if(step===2||(scenario==='timeout'&&step===3)||(scenario==='reuse'&&step===4)){
      if(scenario==='early'&&step===2)await new Promise<void>(resolve=>gates.set('EARLY_PARENT',resolve))
      return response(body,{role:'assistant',tool_calls:[{id:'wait-'+scenario+'-'+step,type:'function',function:{name:'wait_for_subagents',arguments:JSON.stringify({sessionIDs:ids,timeoutSeconds:scenario==='timeout'&&step===2?1:10})}}]},'tool_calls')
    }
    return response(body,{role:'assistant',content:'CASE_FINISHED'},'stop')
  }
  parentCalls++
  if(parentCalls===1)return response(body,{role:'assistant',tool_calls:[call('A',true),call('B',true)]},'tool_calls')
  if(parentCalls===2){
    const toolText=body.messages.filter((m:any)=>m.role==='tool').map((m:any)=>m.content).join(' ')
    const ids=[...toolText.matchAll(/sessionID: (ses_[A-Za-z0-9]+)/g)].map(m=>m[1])
    return response(body,{role:'assistant',tool_calls:[{id:'wait-main',type:'function',function:{name:'wait_for_subagents',arguments:JSON.stringify({sessionIDs:ids,timeoutSeconds:10})}}]},'tool_calls')
  }
  return response(body,{role:'assistant',content:'PARENT_FINISHED'},'stop')
}})
await writeFile(join(configDir,'opencode.json'),JSON.stringify({model:'mock/test',plugins:[{package:pathToFileURL(resolve(import.meta.dir,'..')).href}],agents:{probechild:{mode:'subagent',description:'Native scheduling test child'},probeparent:{mode:'primary'}},providers:{mock:{name:'Local fixture',package:'@ai-sdk/openai-compatible',settings:{baseURL:`http://127.0.0.1:${model.port}/v1`,apiKey:'local-test'},models:{test:{name:'Local fixture',limit:{context:128000,output:2048}}}}}}))
// Use XDG isolation without modifying HOME or the user's service/configuration.
const env={...process.env,XDG_CONFIG_HOME:join(root,'config'),XDG_DATA_HOME:join(root,'data'),XDG_STATE_HOME:join(root,'state'),XDG_CACHE_HOME:join(root,'cache'),OPENCODE_CONFIG_DIR:configDir,OPENCODE_TEST_HOME:root,OPENCODE_DISABLE_PROJECT_CONFIG:'true',OPENCODE_DISABLE_AUTOUPDATE:'true'}
const server=Bun.spawn([binary,'serve','--hostname','127.0.0.1','--port','0','--print-logs'],{cwd:project,env,stdout:'pipe',stderr:'pipe'})
for(const stream of [server.stdout,server.stderr]) void (async()=>{for await(const chunk of stream){logs+=new TextDecoder().decode(chunk); await writeFile(join(root,'server.log'),logs)}})()
console.log('FIXTURE',root)
try {
  const url=await until(async()=>logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0])
  const client=OpenCode.make({baseUrl:url,headers:{authorization:'Basic '+Buffer.from('opencode:'+logs.match(/server password (\S+)/)?.[1]).toString('base64')}})
  const parent=await client.session.create({title:'Native wait research',agent:'probeparent',location:{directory:project}})
  await client.session.prompt({sessionID:parent.id,text:'Run native scheduler probe'})
  await until(async()=>gates.has('A')&&gates.has('B')&&parentCalls===2?true:undefined)
  const context=await client.session.context({sessionID:parent.id})
  await writeFile(join(root,'initial-context.json'),JSON.stringify(context,null,2))
  const tools=context.flatMap((m:any)=>m.content??[]).filter((p:any)=>p.type==='tool')
  const ids=Object.fromEntries(tools.map((t:any)=>[t.state?.input?.description,t.state?.metadata?.sessionID]))
  console.log('TOOL_IDS',JSON.stringify(ids))
  assert(ids.A&&ids.B,'Expected native subagent IDs')
  let aWaitDone=false, bWaitDone=false
  const aWait=client.session.wait({sessionID:ids.A}).then(()=>{aWaitDone=true})
  const bWait=client.session.wait({sessionID:ids.B}).then(()=>{bWaitDone=true})
  await Bun.sleep(100); assert(!aWaitDone&&!bWaitDone,'wait returned while child active')
  gates.get('A')!(); await aWait
  await until(async()=>{const inbox=await client.session.inbox.list({sessionID:parent.id}); return inbox.some((x:any)=>x.payload?.metadata?.childID===ids.A)?inbox:undefined})
  assert(!bWaitDone,'A completion released B waiter')
  assert(parentCalls===2,'A completion started parent model while tool pending')
  console.log('PASS A wait resolves independently; native completion queued; parent tool not interrupted')
  gates.get('B')!(); await bWait

  const queued=await client.session.inbox.list({sessionID:parent.id})
  await writeFile(join(root,'queued-results.json'),JSON.stringify(queued,null,2))
  console.log('PASS both selected background children finished')

  await client.session.wait({sessionID:parent.id})
  assert(Number(parentCalls)===3,'Expected exactly one parent continuation')
  const last=requests.filter(x=>x.name==='parent').at(-1).body
  const txt=JSON.stringify(last.messages)
  assert(txt.includes('RESULT_A')&&txt.includes('RESULT_B'),'Continuation missing child result')
  assert(txt.includes('Native subagent completion notifications are queued'), 'Wait tool did not return ready')
  const endHistory=await client.session.context({sessionID:parent.id})
  const notices=endHistory.filter((m:any)=>m.type==='synthetic')
  assert(notices.length===2,'Plugin duplicated native notifications')
  console.log('PASS wait tool returns ready; one continuation sees both native results, with no duplicated notification')
  const before=requests.length
  await client.session.wait({sessionID:ids.A}); await Bun.sleep(100)
  assert(requests.length===before,'wait on idle child started model work')
  console.log('PASS wait on idle session returns without starting work')
  for(const name of ['FAIL','CANCEL']){
    const child=await client.session.create({title:name,agent:'probechild',location:{directory:project}})
    await client.session.prompt({sessionID:child.id,text:'You are a subagent spawned by another session. CHILD_'+name})
    await until(async()=>gates.has(name)?true:undefined)
    const wait=client.session.wait({sessionID:child.id})
    if(name==='FAIL'||name==='ERR')gates.get(name)!();else await client.session.interrupt({sessionID:child.id})
    await wait
    const info=await client.session.get({sessionID:child.id})
    assert(info.outcome===(name==='FAIL'?'failed':'interrupted'),'Unexpected child outcome '+JSON.stringify(info))
    console.log('PASS session.wait resolves on '+info.outcome+' without returning the failure')
  }
  const idleParent=await client.session.create({title:'Idle native wake research',agent:'probeparent',location:{directory:project}})
  await client.session.prompt({sessionID:idleParent.id,text:'IDLE_PARENT'})
  await until(async()=>gates.has('IDLE')?true:undefined)
  await client.session.wait({sessionID:idleParent.id})
  assert(idleParentCalls===2,'Parent did not finish before child')
  gates.get('IDLE')!()
  await until(async()=>idleParentCalls===3?true:undefined)
  await client.session.wait({sessionID:idleParent.id})
  assert(JSON.stringify(requests.at(-1).body.messages).includes('RESULT_IDLE'),'Idle parent missed background result')
  console.log('PASS completed parent is automatically resumed with background result')
  for(const scenario of ['early','timeout','cancel','error','reuse']){
    const parent=await client.session.create({title:scenario,agent:'probeparent',location:{directory:project}})
    await client.session.prompt({sessionID:parent.id,text:'CASE_'+scenario})
    const tag=({early:'EARLY',timeout:'TIMEOUT',cancel:'CANCELWAIT',error:'ERR',reuse:'REUSE1'} as Record<string,string>)[scenario]
    await until(async()=>gates.has(tag)&&scenarioSteps.get(scenario)===2?true:undefined)
    const state=await client.session.context({sessionID:parent.id})
    const launch=state.flatMap((m:any)=>m.content??[]).find((t:any)=>t.type==='tool'&&t.name==='subagent') as any
    const childID=launch.state.metadata.sessionID
    if(scenario==='early'){
      gates.get(tag)!();await client.session.wait({sessionID:childID})
      await until(async()=>{const inbox=await client.session.inbox.list({sessionID:parent.id});return inbox.some(x=>x.type==='synthetic')?true:undefined})
      gates.get('EARLY_PARENT')!()
    }else if(scenario==='timeout'){
      await until(async()=>scenarioSteps.get(scenario)===3?true:undefined)
      gates.get(tag)!()
    }else if(scenario==='cancel'){
      await until(async()=>{const h=await client.session.context({sessionID:parent.id});return h.flatMap((m:any)=>m.content??[]).some((t:any)=>t.name==='wait_for_subagents'&&t.state.status==='running')?true:undefined})
      await client.session.interrupt({sessionID:parent.id});await client.session.wait({sessionID:parent.id})
      let childDone=false;const childWait=client.session.wait({sessionID:childID}).then(()=>{childDone=true})
      await Bun.sleep(75);assert(!childDone,'Cancelling wait cancelled child')
      gates.get(tag)!();await childWait
    }else gates.get(tag)!()
    if(scenario==='reuse'){
      await until(async()=>gates.has('REUSE2')&&scenarioSteps.get(scenario)===4?true:undefined)
      await Bun.sleep(100);assert(scenarioSteps.get(scenario)===4,'Old receipt completed reused child')
      gates.get('REUSE2')!()
    }
    await until(async()=>(scenarioSteps.get(scenario)??0)>=(scenario==='reuse'?5:scenario==='timeout'?4:3)?true:undefined)
    await client.session.wait({sessionID:parent.id})
    const h=await client.session.context({sessionID:parent.id})
    const waits=h.flatMap((m:any)=>m.content??[]).filter((t:any)=>t.name==='wait_for_subagents') as any[]
    if(scenario==='cancel')assert(waits[0].state.status==='error','Interrupted wait not marked error: '+JSON.stringify(waits[0].state))
    else{
      const results=waits.map(w=>JSON.parse(w.state.content[0].text))
      assert(results.at(-1).status==='ready','Wait did not return ready in '+scenario)
      if(scenario==='timeout')assert(results[0].status==='pending','Timeout falsely completed task')
      if(scenario==='error')assert(results[0].results[0].state==='error','Child error not preserved')
      if(scenario==='reuse')assert(results.length===2,'Missing second wait')
    }
    console.log('PASS plugin scenario',scenario)
  }
  await writeFile(join(root,'summary.json'),JSON.stringify({parentCalls,idleParentCalls,passes:12,version},null,2))
} finally { for(const release of gates.values())release(); server.kill();await server.exited;model.stop(true) }
