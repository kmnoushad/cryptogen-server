// Binance Demo only. No live keys, Supabase, worker controls or strategy changes.
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FuturesAutoExchange } from '../src/futures-auto-executor.js';
import { fadeFilters, decimal, down } from '../src/fade-orders.js';
import { definiteOrderRejection } from '../src/fade-order-state.js';
import { nativeStopCovers, cancelWithAbsenceProof } from '../src/native-stop-proof.js';
export const DEMO_BASE = 'https://demo-fapi.binance.com';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const truth = x => x === true || x === 'true';
export function demoConfig(env, args = []) {
  if (args.some(a => !['--check','--apply','--recover'].includes(a)) && args[0] !== '--recover') throw Error('Use --check, --apply, or --recover JOURNAL');
  const command=args[0] || '--check';
  if (!['--check','--apply','--recover'].includes(command) || (command==='--recover' ? args.length!==2 : args.length>1)) throw Error('Invalid command');
  if (['BINANCE_API_KEY','BINANCE_API_SECRET','FUTURES_BINANCE_API_KEY','FUTURES_BINANCE_API_SECRET'].some(k=>env[k])) throw Error('Live/bot credential variables present. Use only the separate demo environment file.');
  const key=String(env.NEXIO_DEMO_API_KEY ?? '').trim(), secret=String(env.NEXIO_DEMO_API_SECRET ?? '').trim();
  if (!key || !secret || /PASTE|YOUR_/i.test(key+secret)) throw Error('Set NEXIO_DEMO_API_KEY and NEXIO_DEMO_API_SECRET from Binance Demo');
  if (command!=='--check' && env.NEXIO_DEMO_CONFIRMATION!=='DEMO_ONLY_NO_REAL_FUNDS') throw Error('Demo acknowledgement missing');
  return { command, key, secret, symbol:'ETHUSDT', journal:args[1], dir:'/var/tmp/nexio-demo-stop-test', maxNotional:100 };
}
function guard(ex) { if (ex.base !== DEMO_BASE) throw Error('Demo endpoint required; refused'); }
export async function preflight(ex, symbol) {
  guard(ex); await ex.syncTime();
  const mode=await ex.mode(), assets=await ex.assetsMode(), permission=await ex.accountPermissions();
  if (truth(mode.dualSidePosition) || mode.dualSidePosition!==false || assets.multiAssetsMargin!==false || permission.canTrade!==true) throw Error('Demo account needs One-way, Single-Asset mode and trading permission');
  const positions=await ex.positions(), orders=await ex.orders(), algos=await ex.algos();
  if (!Array.isArray(positions) || positions.some(p=>!Number.isFinite(Number(p.positionAmt)) || Number(p.positionAmt)!==0) || orders.length || algos.length) throw Error('Use a dedicated flat Demo account with no ordinary or conditional orders');
  const info=(await ex.info()).symbols.find(s=>s.symbol===symbol);
  if (info?.status!=='TRADING' || info.quoteAsset!=='USDT' || info.contractType!=='PERPETUAL') throw Error('Demo ETHUSDT unavailable');
  const filters=fadeFilters(info);return filters;
}
async function position(ex, job) {
  const rows=await ex.positions();if(!Array.isArray(rows))throw Error('Position read unavailable');
  const p=rows.find(p=>p.symbol===job.symbol && Number(p.positionAmt)!==0);
  if (!p) return 0;
  const amount=Number(p.positionAmt),qty=Math.abs(amount);
  if (p.positionSide!=='BOTH' || !Number.isFinite(qty) || qty>Number(job.entryQty)+1e-8 || (job.direction==='LONG' ? amount<=0 : amount>=0)) throw Error('Demo exposure differs from journal; inspect manually');
  return qty;
}
async function lookup(ex, job, id, kind, wait) {
  for(let i=0;i<4;i++){
    try {return kind==='stop'?await ex.algo(id):await ex.order(job.symbol,id);}
    catch(e){if(e.code!==-2013 || i===3)throw e;await wait(300*(i+1));}
  }
}
function stops(job, anchor, fraction) {
  const f=job.filters, raw=anchor*(job.direction==='LONG'?1-fraction:1+fraction);
  const px=job.direction==='LONG'?down(raw,f.tick):Number((Math.ceil(raw/f.tick)*f.tick).toFixed(8));
  if (!(px>f.minPrice && px<f.maxPrice)) throw Error('Stop outside exchange filters');return px;
}
export async function submitOnce(ex, job, action, send, persist, wait=sleep) {
  guard(ex); if(!job.actions[action.key]){job.actions[action.key]={...action,state:'UNKNOWN'};await persist();
    try { const result=await send();job.actions[action.key].state='ACKNOWLEDGED';await persist();return result; }
    catch(error){job.actions[action.key].error={code:error.code??null,status:error.status??null};if(definiteOrderRejection(error)||error.requestSent===false){job.actions[action.key].state='REJECTED';await persist();throw error;}await persist();}
  }
  // Lost acknowledgement is lookup-only. Never resend the market entry.
  const found=await lookup(ex,job,action.id,action.kind,wait);
  job.actions[action.key].state='LOOKUP_CONFIRMED';await persist();return found;
}
export async function verifyStop(ex,job,key,quantity,wait=sleep) {
  const a=job.actions[key],stop=await lookup(ex,job,a.id,'stop',wait);
  if (!nativeStopCovers(stop,a,{symbol:job.symbol,side:job.direction==='LONG'?'SELL':'BUY',quantity,
    price:a.params.triggerPrice,tick:job.filters.tick,step:job.filters.step})) throw Error('Demo stop proof failed: '+key);
  return stop;
}
async function verifyTarget(ex,job,wait) {
  const action=job.actions.target,order=await lookup(ex,job,action.id,'order',wait);
  if(order.clientOrderId!==action.id || order.symbol!==job.symbol || order.side!==action.params.side ||
    !truth(order.reduceOnly) || !['NEW','PARTIALLY_FILLED'].includes(order.status) ||
    Math.abs(Number(order.origQty)-Number(action.params.quantity))>job.filters.step/2 ||
    !Number.isFinite(Number(order.price)) || Math.abs(Number(order.price)-Number(action.params.price))>job.filters.tick/2)
    throw Error('Demo profit target not confirmed as active');
}
export async function cleanup(ex, job, persist, wait=sleep) {
  guard(ex);
  if(job.actions.entry?.state==='UNKNOWN'){
    const entry=await lookup(ex,job,job.actions.entry.id,'order',wait);
    if(entry.clientOrderId!==job.actions.entry.id)throw Error('Unresolved demo entry; inspect journal and Demo account');
    job.actions.entry.state='LOOKUP_CONFIRMED';await persist();
  }
  const target=job.actions.target;
  if(target)await cancelWithAbsenceProof(()=>ex.cancel(job.symbol,target.id),()=>ex.order(job.symbol,target.id));
  let qty=await position(ex,job);
  if(qty>0){
    const key='cleanup',id=job.prefix+'-close';
    const params={symbol:job.symbol,side:job.direction==='LONG'?'SELL':'BUY',type:'MARKET',reduceOnly:'true',quantity:decimal(qty),newClientOrderId:id,newOrderRespType:'RESULT'};
    try { await submitOnce(ex,job,{key,id,kind:'order',params},()=>ex.place(params),persist,wait); }
    catch(error){ if(await position(ex,job)>0)throw error; }
    for(let i=0;i<4 && (qty=await position(ex,job))>0;i++)await wait(300);
    if(qty>0)throw Error('Demo cleanup not flat; recover this journal before another run');
  }
  // Remove stops only AFTER verified flatness; never create a protection gap.
  for(const a of Object.values(job.actions).filter(a=>a.kind==='stop'))
    await cancelWithAbsenceProof(()=>ex.cancelStop(a.id),()=>ex.algo(a.id));
  const [orders,algos]=await Promise.all([ex.orders(job.symbol),ex.algos(job.symbol)]);
  const owns=o=>String(o.clientOrderId??o.clientAlgoId??'').startsWith(job.prefix+'-');
  if(orders.some(owns)||algos.some(owns))throw Error('Demo bot orders remain; recover journal');
  job.cleaned=true;await persist();
}
export async function scenario(ex, job, persist, {wait=sleep,log=console.log,reload=async()=>JSON.parse(JSON.stringify(job))}={}) {
  guard(ex);const side=job.direction==='LONG'?'SELL':'BUY';
  job.stage='entry';
  const book=await ex.book(job.symbol),entryPrice=Number(job.direction==='LONG'?book.askPrice:book.bidPrice);
  if(!(entryPrice>0))throw Error('Invalid demo quote');
  const f=job.filters,targetNotional=Math.max(25,f.notional*1.2);
  const entryStep=job.profile==='fade'?4*f.step:f.step;
  job.entryQty=Number((Math.ceil(Math.max(f.min,targetNotional/entryPrice)/entryStep)*entryStep).toFixed(8));
  if(!(job.entryQty>=f.min && job.entryQty<=f.max && job.entryQty*entryPrice<=100))throw Error('Demo entry exceeds the $100 test cap');
  await persist();const entryId=job.prefix+'-entry';
  const params={symbol:job.symbol,side:job.direction==='LONG'?'BUY':'SELL',type:'MARKET',quantity:decimal(job.entryQty),newClientOrderId:entryId,newOrderRespType:'RESULT'};
  const entry=await submitOnce(ex,job,{key:'entry',id:entryId,kind:'order',params},()=>ex.place(params),persist,wait);
  if(entry.clientOrderId!==entryId || entry.symbol!==job.symbol)throw Error('Demo entry identity mismatch');
  const qty=await position(ex,job);if(!(qty>0))throw Error('Demo entry has no verified position');
  job.stage='initial stop';
  const oldPrice=stops(job,entryPrice,.03),oldId=job.prefix+'-old';
  await submitOnce(ex,job,{key:'old',id:oldId,kind:'stop',params:{triggerPrice:oldPrice}},
    ()=>job.profile==='fade'?ex.placeStop(job.symbol,oldId,oldPrice):ex.placeDirectionalStop(job.symbol,oldId,oldPrice,side),persist,wait);
  await verifyStop(ex,job,'old',qty,wait);
  // Include the reduce-only target because live replacements coexist with it.
  job.stage='profit target';
  const partial=job.profile==='fade'?down(qty*.75,f.step):qty;
  if(!(partial>=f.min))throw Error('Partial test quantity below exchange minimum');
  const targetPrice=job.direction==='LONG'?entryPrice*1.04:entryPrice*.96;
  const targetId=job.prefix+'-target';const targetParams={symbol:job.symbol,side,type:'LIMIT',timeInForce:'GTC',reduceOnly:'true',quantity:decimal(partial),price:decimal(down(targetPrice,f.tick)),newClientOrderId:targetId};
  await submitOnce(ex,job,{key:'target',id:targetId,kind:'order',params:targetParams},()=>ex.place(targetParams),persist,wait);
  await verifyTarget(ex,job,wait);
  const quote=await ex.book(job.symbol),mark=Number(job.direction==='LONG'?quote.bidPrice:quote.askPrice);
  const newPrice=stops(job,mark,.015);
  if(job.direction==='LONG'?newPrice<=oldPrice:newPrice>=oldPrice)throw Error('Demo price moved too far to tighten safely');
  job.stage='quantity stop replacement';
  const newId=job.prefix+'-new';const newParams={triggerPrice:newPrice,quantity:decimal(qty)};
  await submitOnce(ex,job,{key:'new',id:newId,kind:'stop',params:newParams},
    ()=>job.profile==='fade'?ex.placeStop(job.symbol,newId,newPrice,qty):ex.placeDirectionalStop(job.symbol,newId,newPrice,side,qty),persist,wait);
  await verifyStop(ex,job,'new',await position(ex,job),wait);await verifyStop(ex,job,'old',await position(ex,job),wait);
  await verifyTarget(ex,job,wait);
  log(`${job.profile} ${job.direction}: original + quantity replacement + target coexist: PASS`);
  await cancelWithAbsenceProof(()=>ex.cancelStop(oldId),()=>ex.algo(oldId));
  await verifyStop(ex,job,'new',await position(ex,job),wait);
  if(job.profile==='fade'){
    await cancelWithAbsenceProof(()=>ex.cancel(job.symbol,targetId),()=>ex.order(job.symbol,targetId));
    const before=await position(ex,job);if(Math.abs(before-qty)>f.step/2)throw Error('Position changed before manual demo partial; abort');
    job.stage='partial close';
    const cutId=job.prefix+'-partial';const cutParams={symbol:job.symbol,side,type:'MARKET',reduceOnly:'true',quantity:decimal(partial),newClientOrderId:cutId,newOrderRespType:'RESULT'};
    await submitOnce(ex,job,{key:'partial',id:cutId,kind:'order',params:cutParams},()=>ex.place(cutParams),persist,wait);
    const runner=await position(ex,job);if(!(runner>=f.min && Math.abs(runner-(qty-partial))<=f.step/2))throw Error('Demo runner quantity not confirmed');
    job.stage='runner stop replacement';
    const runnerBook=await ex.book(job.symbol),trail=stops(job,Number(runnerBook.askPrice),.01),trailId=job.prefix+'-trail';
    if(trail>=newPrice)throw Error('Demo quote moved too far to tighten runner safely');
    await submitOnce(ex,job,{key:'trail',id:trailId,kind:'stop',params:{triggerPrice:trail,quantity:decimal(runner)}},()=>ex.placeStop(job.symbol,trailId,trail,runner),persist,wait);
    await verifyStop(ex,job,'trail',await position(ex,job),wait);
    await cancelWithAbsenceProof(()=>ex.cancelStop(newId),()=>ex.algo(newId));
    log('fade SHORT: reduced-size runner replacement accepted: PASS');
  }
  // Re-read serialized intents and verify all remaining active stop parameters.
  job.stage='journal readback';
  await persist();const reloaded=await reload();const last=job.profile==='fade'?'trail':'new';
  await verifyStop(ex,reloaded,last,await position(ex,job),wait);
  job.passed=true;await persist();log(`${job.profile} ${job.direction}: journal reload/readback: PASS`);
}
export function validateJournal(state) {
  if(state?.schema!==1 || !/^[a-f0-9]{64}$/.test(state.credentialFingerprint ?? '') || state.endpoint!==DEMO_BASE || !/^[a-f0-9]{10}$/.test(state.runId) || !Array.isArray(state.jobs)||state.jobs.length>3)throw Error('Invalid demo recovery journal');
  for(const j of state.jobs){
    if(j.symbol!=='ETHUSDT'||!['LONG','SHORT'].includes(j.direction)||!['futures','fade'].includes(j.profile)||!j.prefix.startsWith('ndt-'+state.runId+'-')||j.prefix.length>19||!(Number(j.entryQty)>=0))throw Error('Invalid demo job');
    for(const a of Object.values(j.actions)){if(!a.id.startsWith(j.prefix+'-')||a.id.length>36||!['order','stop'].includes(a.kind))throw Error('Invalid demo action');}
  }
}
async function main() {
  if(process.argv.includes('--help')){console.log('Demo only: --check (read-only default), --apply (demo trades), --recover JOURNAL. Separate NEXIO_DEMO_* environment variables required.');return;}
  const cfg=demoConfig(process.env,process.argv.slice(2));
  const ex=new FuturesAutoExchange({environment:'testnet',key:cfg.key,secret:cfg.secret});guard(ex);
  await mkdir(cfg.dir,{recursive:true,mode:0o700});
  const lock=join(cfg.dir,createHash('sha256').update(cfg.key).digest('hex').slice(0,16)+'.lock');
  let ownsLock=false,state,file;
  try {
    if(cfg.command==='--recover'){
      file=resolve(cfg.journal);if(!file.startsWith(resolve(cfg.dir)+'/'))throw Error('Recovery journal must be inside the demo test directory');
      state=JSON.parse(await readFile(file,'utf8'));validateJournal(state);
      if(state.credentialFingerprint!==createHash('sha256').update(cfg.key).digest('hex'))throw Error('Recovery requires the same Demo API key as the original run');
    }
    try {await mkdir(lock,{mode:0o700});ownsLock=true;}
    catch(error){
      if(error.code!=='EEXIST')throw error;
      const previous=JSON.parse(await readFile(join(lock,'owner.json'),'utf8'));let alive=true;
      if(!Number.isInteger(previous.pid)||previous.pid<=1)throw Error('Invalid demo lock; inspect before retrying');
      try{process.kill(previous.pid,0);}catch(e){if(e.code==='ESRCH')alive=false;else throw e;}
      if(alive||cfg.command!=='--recover')throw Error('Demo test lock present. Finish the active run, or recover its journal: '+String(previous.journal));
      await rm(lock,{recursive:true});await mkdir(lock,{mode:0o700});ownsLock=true;
    }
    if(!state){const runId=randomUUID().replace(/-/g,'').slice(0,10);state={schema:1,runId,endpoint:DEMO_BASE,credentialFingerprint:createHash('sha256').update(cfg.key).digest('hex'),jobs:[]};file=join(cfg.dir,runId+'.json');}
    await writeFile(join(lock,'owner.json'),JSON.stringify({pid:process.pid,journal:file}),{mode:0o600});
    const persist=async()=>{const temp=file+'.tmp';await writeFile(temp,JSON.stringify(state,null,2),{mode:0o600});await rename(temp,file);};
    console.log('DEMO ONLY; endpoint '+DEMO_BASE+'; journal '+file);
    if(cfg.command==='--recover'){await ex.syncTime();for(const job of state.jobs.filter(j=>!j.cleaned))await cleanup(ex,job,persist);console.log('Demo journal cleanup verified. No new entry orders sent.');return;}
    const filters=await preflight(ex,cfg.symbol);
    if(cfg.command==='--check'){console.log('Demo account preflight passed. No orders or configuration changes made.');return;}
    await ex.isolate(cfg.symbol);
    for(const [profile,direction] of [['futures','LONG'],['futures','SHORT'],['fade','SHORT']]){
      const job={profile,direction,symbol:cfg.symbol,prefix:`ndt-${state.runId}-${state.jobs.length}`,filters,entryQty:0,actions:{},cleaned:false};state.jobs.push(job);await persist();
      try {await scenario(ex,job,persist,{reload:async()=>{const saved=JSON.parse(await readFile(file,'utf8'));validateJournal(saved);return saved.jobs.find(j=>j.prefix===job.prefix);}});}
      catch(error){job.failure={stage:job.stage,code:error.code??null,status:error.status??null,reason:error.message};await persist();throw error;}
      finally {await cleanup(ex,job,persist);}
      await preflight(ex,cfg.symbol);
    }
    console.log('DEMO ACCEPTANCE TEST PASSED: three profiles; account flat; test orders cleared. Trigger fills, actual +1R timing and full worker restart recovery were not tested.');
  } catch(error) {console.error('DEMO TEST FAILED: '+error.message);if(file)console.error('Recovery journal: '+file);process.exitCode=1;}
  finally {if(ownsLock && state?.jobs?.every(j=>j.cleaned))await rm(lock,{recursive:true,force:true});}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await main();
