import {appendFile,mkdir,readdir,unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {FuturesAutoWorkerLoop} from './futures-auto-worker-loop.js';
import {momentumSignal} from './momentum-live-policy.js';
import {recordDailyGate,recordScanCoverage} from './daily-gates.js';
export class MomentumRanker {
 constructor(){this.history=new Map();this.cursor=0;}
 select(info,tickers,now){
  if(!Array.isArray(tickers)||!Array.isArray(info?.symbols))throw Error('Universe data unavailable');
  const contracts=new Map(info.symbols.filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.quoteAsset==='USDT'&&(!s.marginAsset||s.marginAsset==='USDT')).map(s=>[s.symbol,s]));
  const eligible=[];let warm=0;
  for(const t of tickers){
   const c=contracts.get(t.symbol),price=Number(t.lastPrice),vol=Number(t.quoteVolume),count=Number(t.count),change=Number(t.priceChangePercent),age=(now-Number(c?.onboardDate))/86400000;
   if(!c||!/^[A-Z0-9]+USDT$/.test(t.symbol)||![price,vol,count,change,age].every(Number.isFinite)||price<=0||vol<5e6||count<1000||age<3)continue;
   let history=(this.history.get(t.symbol)??[]).filter(x=>now-x.time<=32*60000&&x.time<=now);
   if(!history.length||now-history.at(-1).time>=45000)history.push({time:now,price});this.history.set(t.symbol,history);
   const returns=[5,15,30].map(n=>{const old=history.filter(x=>x.time<=now-n*60000).at(-1);return old&&now-n*60000-old.time<=90000?100*(price/old.price-1):null;});
   if(returns[0]!==null)warm++;
   const score=returns[0]===null?0:Math.abs(returns[0])*2+Math.abs(returns[1]??0)+Math.abs(returns[2]??0)*.5;
   eligible.push({symbol:t.symbol,score,vol,change,returns,quality:{checkedAt:now,quoteVolume:vol,trades:count,listingAgeDays:age,longAllowed:age>=14,changePct:change}});
  }
  const eligibleSet=new Set(eligible.map(x=>x.symbol));for(const k of this.history.keys())if(!eligibleSet.has(k))this.history.delete(k);
  const chosen=new Set(),add=(rows,n)=>{let added=0;for(const r of rows){if(added>=n||chosen.size>=24)break;if(!chosen.has(r.symbol)){chosen.add(r.symbol);added++;}}};
  add([...eligible].sort((a,b)=>b.score-a.score||a.symbol.localeCompare(b.symbol)),12);
  add([...eligible].sort((a,b)=>b.vol-a.vol),4);add([...eligible].sort((a,b)=>Math.abs(b.change)-Math.abs(a.change)),4);
  const rest=eligible.filter(x=>!chosen.has(x.symbol)).sort((a,b)=>a.symbol.localeCompare(b.symbol));
  if(rest.length){add(Array.from({length:rest.length},(_,i)=>rest[(this.cursor+i)%rest.length]),24-chosen.size);this.cursor=(this.cursor+4)%rest.length;}
  return {symbols:[...chosen],eligible,quality:new Map(eligible.map(x=>[x.symbol,x.quality])),warm};
 }
}
export async function logMomentum(kind,payload,now=Date.now()){
 const dir=process.env.NEXIO_MOMENTUM_DATA_DIR||'/var/lib/nexio-binance/momentum-live';await mkdir(dir,{recursive:true,mode:0o700});
 const date=new Date(now).toISOString().slice(0,10);
 await appendFile(join(dir,date+'.jsonl'),JSON.stringify({time:now,kind,...payload})+'\n',{mode:0o600});
 // Bounded local capture. Never touch runtime jobs or exchange state.
 if(kind==='snapshot')for(const name of await readdir(dir))if(/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)&&now-Date.parse(name.slice(0,10))>8*86400000)await unlink(join(dir,name));
}
export class MomentumLiveWorker extends FuturesAutoWorkerLoop {
 constructor(options){super(options);this.ranker=new MomentumRanker();this.watchLog=new Map();this.loggedBars=new Map();this.log=options.log??logMomentum;}
 async tick(){
  if(this.busy||this.stopped)return;this.busy=true;const ex=this.executor;let stats;
  try{
   if(!await this.maintain())return;
   const now=this.now(),minute=Math.floor(now/60000);if(now%60000<3000||minute===this.lastScanMinute||now<this.dataBackoffUntil)return;
   this.lastScanMinute=minute;
   if(!this.exchangeInfo||now-this.exchangeInfoAt>3600000){this.exchangeInfo=await ex.exchange.info();this.exchangeInfoAt=this.now();}
   const tickers=await ex.exchange.ticker24h(),at=this.now();
   const universe=this.ranker.select(this.exchangeInfo,tickers,at);
   await this.log('snapshot',{tickers:tickers.map(t=>[t.symbol,t.lastPrice,t.quoteVolume,t.count]),selected:universe.symbols},at);
   ex.universeSummary=`Momentum: ${universe.eligible.length} eligible ticker snapshots · ${universe.warm} have 5m history · ${universe.symbols.length} deep scans`;
   stats=ex.scanStats={startedAt:at,scanned:0,confirmed:0,attempted:0,expired:0,dataErrors:0};ex.scanReasons={};
   for(const symbol of universe.symbols){
    if(this.stopped||ex.lastError||this.now()<this.dataBackoffUntil)break;
    if(this.now()-this.lastMaintenance>=5000&&!await this.maintain())break;
    try{
     const [m1,m15]=await Promise.all([ex.exchange.candles(symbol,'1m',499),this.candles(symbol,'15m')]);
     const signal=momentumSignal({symbol,m1,m15,now:this.now()});
     signal.marketQuality=universe.quality.get(symbol);recordScanCoverage(ex,symbol);
     recordDailyGate(ex,'scan',signal.reason,symbol,{id:minute,outcome:signal.allowed?'info':'blocked'});
     ex.scanReasons[symbol]=signal.reason;
     const lastLogged=this.loggedBars.get(symbol)??{m1:0,m15:0};
     const captured={m1:m1.filter(r=>Number(r[6])>lastLogged.m1&&Number(r[6])<this.now()),m15:m15.filter(r=>Number(r[6])>lastLogged.m15&&Number(r[6])<this.now())};
     await this.log('decision',{symbol,signal,...captured},this.now());
     this.loggedBars.set(symbol,{m1:Number(captured.m1.at(-1)?.[6]??lastLogged.m1),m15:Number(captured.m15.at(-1)?.[6]??lastLogged.m15)});
     if(signal.watch&&this.now()-(this.watchLog.get(symbol)??0)>600000){console.log(`MOMENTUM WATCH ${symbol}: ${signal.reason}`);this.watchLog.set(symbol,this.now());}
     if(signal.allowed){stats.confirmed++;stats.attempted++;await ex.onSignal(symbol,signal);ex.scanReasons[symbol]=ex.lastError??ex.reason;await this.log('execution',{symbol,reason:ex.scanReasons[symbol]},this.now());}
    }catch(e){stats.dataErrors++;ex.scanReasons[symbol]=e.message;if(e.status===429||e.status===418||e.code===-1003){this.dataBackoffUntil=this.now()+(e.retryAfterMs??60000);break;}}
    finally{stats.scanned++;this.lastProgress=this.now();}
   }
   if(!stats.attempted&&!ex.lastError)ex.reason='Momentum scan: no confirmed entry';
  }catch(e){await ex.failed(e);}
  finally{if(stats)stats.completedAt=this.now();try{await this.store.heartbeat(ex.scope,ex.status());}catch{}this.lastProgress=this.now();this.busy=false;}
 }
}
