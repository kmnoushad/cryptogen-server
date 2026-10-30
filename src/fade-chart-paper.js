import {readFile,writeFile,mkdir,rename,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
import {get_score,series} from './fade-chart-score.js';
import {checkMonitoringDaily} from './fade-chart-monitoring.js';
const DAY=86400000,SIX_HOURS=21600000;
// An explicit public-GET allowlist. No signed requests, API keys, order client,
// executor imports, live handoffs, account reads or Binance demo orders.
export class FadeChartPublicData{
 constructor({fetcher=fetch}={}){this.fetcher=fetcher;}
 async get(path,params={}){
  if(!['/fapi/v1/exchangeInfo','/fapi/v1/ticker/24hr','/fapi/v1/klines','/fapi/v1/ticker/bookTicker'].includes(path))throw Error('Public market-data endpoint not allowed');
  const u=new URL(path,'https://fapi.binance.com');for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  const r=await this.fetcher(u,{method:'GET',signal:AbortSignal.timeout(10000)});
  if(!r.ok){const e=Error(`Public data HTTP ${r.status}`);e.status=r.status;e.retryAfterMs=Math.max(60000,Number(r.headers.get('retry-after')??60)*1000);throw e;}
  return r.json();
 }
 info(){return this.get('/fapi/v1/exchangeInfo');}
 tickers(){return this.get('/fapi/v1/ticker/24hr');}
 ticker(symbol){return this.get('/fapi/v1/ticker/24hr',{symbol});}
 candles(symbol,interval,limit){return this.get('/fapi/v1/klines',{symbol,interval,limit});}
 book(symbol){return this.get('/fapi/v1/ticker/bookTicker',{symbol});}
}
export async function monitoringSnapshot(path,now){
 // Monitoring is a Spot/Margin label, not a futures exchangeInfo field.
 // Do not infer it from old announcements, project age, or token price.
 try{
  const d=JSON.parse(await readFile(path,'utf8'));
  const valid=Array.isArray(d.symbols)&&d.symbols.every(s=>/^[A-Z0-9]+$/.test(s))&&Array.isArray(d.sources)&&d.sources.length>0&&d.sources.every(s=>{try{const u=new URL(s);return u.protocol==='https:'&&(u.hostname==='www.binance.com'||u.hostname==='binance.com');}catch{return false;}})&&Number.isFinite(d.checkedAt)&&now-d.checkedAt>=0&&now-d.checkedAt<DAY&&d.complete===true;
  return valid?{status:'verified',checkedAt:d.checkedAt,symbols:new Set(d.symbols),source:d.sources}:{status:'unknown',reason:'Daily reviewed Monitoring snapshot stale/invalid'};
 }catch{return {status:'unknown',reason:'No daily reviewed Monitoring snapshot'};}
}
export class FadeChartPaper{
 constructor({directory,market=new FadeChartPublicData(),now=()=>Date.now(),threshold=50}={}){
  if(!directory)throw Error('Separate paper data directory required');
  Object.assign(this,{directory,market,now,threshold});this.busy=false;this.backoffUntil=0;this.daily=new Map();this.lastScan=0;
 }
 async initialize(){
  await mkdir(this.directory,{recursive:true,mode:0o700});
  try{this.state=JSON.parse(await readFile(join(this.directory,'state.json'),'utf8'));}
  catch(e){if(e.code!=='ENOENT')throw e;this.state={model:'fade-chart-paper-v1',cash:100,positions:[],closed:[],lastEntries:{},evaluated:{},lastScoredBar:0};}
  if(this.state.model!=='fade-chart-paper-v1'||!Number.isFinite(this.state.cash)||!Array.isArray(this.state.positions)||!Array.isArray(this.state.closed)||!this.state.lastEntries||!this.state.evaluated)throw Error('Invalid paper state; do not reset automatically');
  if(this.state.positions.some(p=>!p.id||!/^[A-Z0-9]+USDT$/.test(p.symbol)||['entry','qty','stop','target','notional','plannedRisk','openedAt','lastBarEnd','expiresAt'].some(k=>!Number.isFinite(p[k]))||p.qty<=0||p.entry<=0||p.stop<=p.entry||p.target>=p.entry)||this.state.closed.some(t=>!Number.isFinite(t.net)||!t.score?.components))throw Error('Invalid paper trade journal; manual review required');
  await this.save();
 }
 async save(){const p=join(this.directory,'state.json'),tmp=p+'.tmp';await writeFile(tmp,JSON.stringify(this.state),{mode:0o600});await rename(tmp,p);}
 async log(kind,data){const at=this.now();await appendFile(join(this.directory,new Date(at).toISOString().slice(0,10)+'.jsonl'),JSON.stringify({at,kind,model:this.state.model,...data})+'\n',{mode:0o600});}
 async get_score(symbol,args){return get_score(symbol,{...args,threshold:this.threshold,now:this.now()});}
 async open(score,book){
  const now=this.now(),symbol=score.symbol;
  if(!score.allowed||score.executable!==false)return {opened:false,reason:'No confirmed simulated setup'};
  if(this.state.positions.some(p=>p.symbol===symbol)||now-(this.state.lastEntries[symbol]??-Infinity)<SIX_HOURS)return {opened:false,reason:'One fade per symbol per six hours'};
  if(this.state.positions.length>=3)return {opened:false,reason:'Three simulated positions maximum'};
  const bid=Number(book?.bidPrice),ask=Number(book?.askPrice);
  if(![bid,ask].every(Number.isFinite)||bid<=0||ask<bid||ask/bid-1>.002)return {opened:false,reason:'Invalid/wide paper entry quote'};
  // Fresh REST receipt; adverse modeled entry slip and no historical close fill.
  const entry=bid*(1-.0005),distance=score.stop/entry-1;
  if(distance<=0||distance>.08||Math.abs(bid/score.entry-1)>.005)return {opened:false,reason:'Stop >8%, wrong side, or entry moved >0.5%'};
  const costs=.002,used=this.state.positions.reduce((s,p)=>s+p.notional/2,0),marginRoom=Math.max(0,this.state.cash*.5-used);
  const equity=this.state.cash+this.state.positions.reduce((s,p)=>s+p.qty*(p.entry-p.mark),0);
  const risk=Math.min(1,Math.max(0,equity)*.01)*score.sizeMultiplier;
  const notional=Math.min(risk/(distance+costs),150*score.sizeMultiplier,marginRoom*2);
  if(!(notional>=5))return {opened:false,reason:'Safe simulated size below $5 minimum'};
  const qty=notional/entry,plannedRisk=qty*(score.stop-entry)+notional*costs;
  const target=(entry*(1-.0005)-1.5*plannedRisk/qty)/(1+.0005);
  if(!(target>0&&target<entry))return {opened:false,reason:'Simulated target invalid'};
  const p={id:`${symbol}:${score.barCloseTime}`,symbol,entry,mark:ask,stop:score.stop,target,qty,notional,plannedRisk,openedAt:now,lastBarEnd:now,expiresAt:now+4*3600000,score};
  this.state.positions.push(p);this.state.lastEntries[symbol]=now;await this.save();await this.log('OPEN',{position:p});return {opened:true,position:p};
 }
 async close(p,price,reason,at){
  const exit=price*1.0005,gross=p.qty*(p.entry-exit),fees=.0005*p.qty*(p.entry+exit),net=gross-fees;
  const row={...p,exit,closedAt:at,reason,gross,fees,net,funding:'not modeled'};
  this.state.cash+=net;this.state.positions=this.state.positions.filter(x=>x.id!==p.id);this.state.closed.push(row);
  await this.save();await this.log('CLOSE',{trade:row});
 }
 async manage(){
  for(const p of [...this.state.positions]){
   const fetched=this.now(),rows=await this.market.candles(p.symbol,'1m',1500),now=this.now();
   if(now-fetched>10000)throw Error('Paper exit candle read stale');
   const a=series(rows,60000,now).filter(b=>b.end>p.lastBarEnd);
   // Never use the pre-entry part of the signal/current minute as a stop/TP.
   const complete=a.filter(b=>b.time>=p.openedAt);
   const expected=Math.ceil((p.lastBarEnd+1)/60000)*60000;
   if(complete.length&&complete[0].time>expected)throw Error(`Missing simulated exit candles: ${p.symbol}`);
   let closed=false;
   for(const b of complete){
    // Conservative OHLC replay: stop first if target and stop touched together.
    if(b.high>=p.stop){await this.close(p,Math.max(p.stop,b.open),'STOP',b.end);closed=true;break;}
    if(b.low<=p.target){await this.close(p,p.target,'TARGET',b.end);closed=true;break;}
    p.lastBarEnd=b.end;
    if(b.end>=p.expiresAt){await this.close(p,b.close,'TIME',b.end);closed=true;break;}
   }
   if(closed)continue;
   const quoteAt=this.now(),book=await this.market.book(p.symbol),ask=Number(book.askPrice);
   if(this.now()-quoteAt>5000||!(ask>0&&Number.isFinite(ask)))throw Error('Paper exit quote unavailable/stale');
   p.mark=ask;
   if(ask>=p.stop)await this.close(p,ask,'STOP_QUOTE',this.now());
   else if(ask<=p.target)await this.close(p,ask,'TARGET_QUOTE',this.now());
   else if(this.now()>=p.expiresAt)await this.close(p,ask,'TIME_QUOTE',this.now());
   else await this.save();
  }
 }
 async tick(){
  if(this.busy||this.now()<this.backoffUntil)return;this.busy=true;
  try{
   await this.manage();const now=this.now(),bar=Math.floor(now/900000)*900000-1;
   if(now%900000<3000||bar===this.lastScan)return;this.lastScan=bar;
   const info=await this.market.info(),tickers=await this.market.tickers(),at=this.now();
   if(at-now>15000||!Array.isArray(tickers)||!Array.isArray(info?.symbols))throw Error('Public universe data stale/invalid');
   const contracts=new Map(info.symbols.filter(s=>s.status==='TRADING'&&s.contractType==='PERPETUAL'&&s.quoteAsset==='USDT'&&(!s.marginAsset||s.marginAsset==='USDT')&&(!s.underlyingType||s.underlyingType==='COIN')).map(s=>[s.symbol,s]));
   const tags=await monitoringSnapshot(join(this.directory,'monitoring.json'),at);
   const autoTags=tags.status==='verified'?null:await checkMonitoringDaily(this.directory,at);
   this.state.monitoringStatus=tags.status==='verified'?'Daily reviewed snapshot':autoTags.status+': '+autoTags.reason;
   const candidates=tickers.filter(t=>contracts.has(t.symbol)&&Number(t.lowPrice)>0&&Number(t.lastPrice)>=2*Number(t.lowPrice)).sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume));
   // Sequential bounded requests; no ranking cap silently drops pumped coins.
   for(const t of candidates){
    if(this.now()-now>180000){await this.log('SCAN_INCOMPLETE',{reason:'Three-minute scan budget',remaining:candidates.length});break;}
    if(this.state.evaluated[t.symbol]===bar)continue;
    const contract=contracts.get(t.symbol),rows=await this.market.candles(t.symbol,'15m',150);
    let daily=this.daily.get(t.symbol);if(!daily||Math.floor(daily.at/DAY)!==Math.floor(this.now()/DAY)){
     try{daily={at:this.now(),rows:await this.market.candles(t.symbol,'1d',182)};this.daily.set(t.symbol,daily);}catch(e){if(e.status===429||e.status===418)throw e;daily={rows:[]};}
    }
    const monitoring=tags.status==='verified'?{...tags,tagged:tags.symbols.has(contract.baseAsset)}:autoTags.symbols.includes(contract.baseAsset)?{status:'verified',tagged:true,checkedAt:autoTags.checkedAt,source:autoTags.source}:tags;
    let ticker={...t,observedAt:at};if(this.now()-at>45000){const freshAt=this.now();ticker={...await this.market.ticker(t.symbol),observedAt:freshAt};}
    const score=await this.get_score(t.symbol,{rows,dailyRows:daily.rows,ticker,contract,monitoring});
    // Score row includes every point, raw metric, unavailable flag and reason.
    await this.log('SCORE',{score});this.state.evaluated[t.symbol]=bar;await this.save();
    if(score.allowed){const qAt=this.now(),book=await this.market.book(t.symbol);if(this.now()-qAt>5000)throw Error('Stale paper entry quote');const result=await this.open(score,book);await this.log('ENTRY_CHECK',{symbol:t.symbol,barCloseTime:score.barCloseTime,opened:result.opened,reason:result.reason??'Simulated entry'});}
   }
   this.state.lastScoredBar=bar;this.state.lastScanAt=this.now();this.state.lastError=null;await this.save();
  }catch(e){this.state.lastError=e.message;if(e.status===429||e.status===418)this.backoffUntil=this.now()+(e.retryAfterMs??60000);await this.save();await this.log('ERROR',{reason:e.message});}
  finally{this.busy=false;}
 }
 summary(){return {model:this.state.model,mode:'SIMULATION ONLY — no Binance orders',cash:this.state.cash,open:this.state.positions.length,closed:this.state.closed.length,net:this.state.closed.reduce((s,t)=>s+t.net,0),lastScanAt:this.state.lastScanAt??null,lastError:this.state.lastError??null,funding:'not modeled'};}
}
