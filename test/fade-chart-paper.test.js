import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {get_score,macd,series} from '../src/fade-chart-score.js';
import {FadeChartPaper,FadeChartPublicData,monitoringSnapshot} from '../src/fade-chart-paper.js';
import {fadeChartStatus} from '../src/fade-chart-status.js';
import {monitoringTokens,checkMonitoringDaily} from '../src/fade-chart-monitoring.js';
const NOW=Date.parse('2026-10-31T12:00:04Z'),DAY=86400000;
function bars(n,interval,price=100){const end=Math.floor(NOW/interval)*interval;return Array.from({length:n},(_,i)=>{const t=end-(n-i)*interval;return [t,price,price+1,price-1,price,100,t+interval-1];});}
function fixture(){
 const rows=bars(150,900000);Object.assign(rows[147],{1:100.1,2:104,3:99,4:100,5:1000});Object.assign(rows[148],{1:100,2:103,3:98,4:99});Object.assign(rows[149],{1:99,2:100,3:96,4:97});
 const dailyRows=bars(181,DAY);dailyRows.at(-1)[4]=20;dailyRows.at(-1)[3]=19;
 return {rows,dailyRows,ticker:{symbol:'AAAUSDT',lowPrice:40,lastPrice:97,observedAt:NOW},contract:{onboardDate:NOW-10*DAY},monitoring:{status:'verified',tagged:true,checkedAt:NOW,source:['https://www.binance.com/en/markets']},now:NOW,threshold:40};
}
test('Phase1B scores all ideas, logs unavailable flags and needs close confirmation',()=>{
 const x=fixture(),s=get_score('AAAUSDT',x);assert.equal(s.allowed,true,s.reason);assert.equal(s.executable,false);assert.equal(s.mode,'SIMULATION');assert.equal(Object.keys(s.components).length,15);
 assert.equal(s.components.largest_volume_red.points,10);assert.equal(s.components.upper_wick_near_high.points,10);assert.equal(s.components.monitoring_tag.points,10);assert.equal(s.components.down_70pct_180d.points,10);assert.equal(s.components.listed_under_30d.points,5);assert.equal(s.sizeMultiplier,.5);
 assert.equal(s.score,Object.values(s.components).reduce((sum,c)=>sum+c.points,0));
 const weak=fixture();Object.assign(weak.rows.at(-1),{1:99,2:102,3:96,4:100});assert.equal(get_score('AAAUSDT',weak).confirmation.confirmed,false);
});
test('pump is current and closed price /24h low, not ticker open-to-close change',()=>{
 const x=fixture();x.ticker.priceChangePercent=200;x.ticker.lowPrice=60;assert.equal(get_score('AAAUSDT',x).allowed,false);assert.match(get_score('AAAUSDT',x).reason,/100%/);
 x.ticker.lowPrice=48.5;assert.equal(get_score('AAAUSDT',x).components.pump_100pct.active,true);
 x.ticker.lastPrice=1000;x.ticker.lowPrice=49;assert.equal(get_score('AAAUSDT',x).allowed,false,'forming pump cannot qualify prior closed candle');
});
test('forming candles do not contribute; gaps, stale close/ticker and invalid OHLC are rejected',()=>{
 const x=fixture(),base=get_score('AAAUSDT',x);const forming=bars(1,900000)[0];forming[0]+=900000;forming[6]+=900000;forming[2]=10000;
 assert.deepEqual(get_score('AAAUSDT',{...x,rows:[...x.rows,forming]}),base);
 for(const mutate of [v=>v.rows.splice(60,1),v=>v.rows.at(-1)[2]=1,v=>v.now+=900000,v=>v.ticker.observedAt-=61000]){const z=fixture();mutate(z);assert.equal(get_score('AAAUSDT',z).allowed,false);}
});
test('MA chop and volume bounce/breakout components use quantitative definitions',()=>{
 const x=fixture();x.rows=bars(150,900000);x.ticker.lastPrice=100;let s=get_score('AAAUSDT',x);assert.equal(s.components.flat_ma_chop.points,-10);
 Object.assign(x.rows[145],{1:101,2:102,3:98,4:99,5:1000});Object.assign(x.rows[146],{1:99,2:101,3:98,4:100,5:400});
 s=get_score('AAAUSDT',x);assert.equal(s.components.weak_green_bounce.points,10);
 Object.assign(x.rows.at(-1),{1:100,2:110,3:99,4:109,5:1100});s=get_score('AAAUSDT',x);assert.equal(s.components.green_volume_breakout.points,-15);assert.equal(s.components.weak_green_bounce.points,0);
});
test('unknown/stale Monitoring and short daily histories are not invented',()=>{
 const x=fixture();x.monitoring.checkedAt=NOW-DAY;x.dailyRows=bars(100,DAY);x.contract.onboardDate=null;
 const s=get_score('AAAUSDT',x);assert.equal(s.components.monitoring_tag.active,null);assert.equal(s.components.monitoring_tag.points,0);assert.equal(s.components.down_70pct_180d.active,null);assert.equal(s.components.listed_under_30d.active,null);assert.equal(s.sizeMultiplier,.5);
});
test('MACD constant series has zero line/signal/hist after warmup',()=>{
 const m=macd(Array(150).fill(100));assert.equal(m.line.at(-1),0);assert.equal(m.signal.at(-1),0);assert.equal(m.hist.at(-1),0);assert.equal(m.signal[32],null);
});
test('MA recovery veto, bearish crosses and confirmed MACD divergence award exact weights',()=>{
 const x=fixture();let s=get_score('AAAUSDT',x);assert.equal(s.components.ma7_cross_below_ma25.points,15);assert.equal(s.components.ma25_rejection.points,15);
 Object.assign(x.rows.at(-1),{1:99,2:106,3:98,4:105});s=get_score('AAAUSDT',x);assert.equal(s.components.ma_recovery.points,-20);assert.equal(s.allowed,false);assert.match(s.reason,/recovery/);
 const d=fixture();Object.assign(d.rows[135],{1:100,2:110,3:99,4:108});Object.assign(d.rows[145],{1:100,2:111,3:99,4:100});s=get_score('AAAUSDT',d);assert.equal(s.components.macd_bearish_divergence.points,15);
 const z=fixture();z.rows=z.rows.map((r,i)=>{let c=100+i*.2;return [r[0],c,c+.5,c-.5,c,100,r[6]];});Object.assign(z.rows.at(-1),{1:130,2:131,3:119,4:120});z.ticker.lastPrice=120;
 assert.equal(get_score('AAAUSDT',z).components.macd_cross_down_above_zero.points,10);
});
test('Monitoring daily checker does not mistake menu labels for token tags and caches failures',async()=>{
 assert.deepEqual(monitoringTokens('<nav>Monitoring AAA</nav><script type="application/json">{"tokens":[{"symbol":"AAA","tags":["Monitoring"]},{"symbol":"BBB","tags":["Seed"]}]}</script>'),['AAA']);
 assert.deepEqual(monitoringTokens('<nav>Monitoring</nav><a>AAA</a>'),[]);
 const directory=await mkdtemp(join(tmpdir(),'fadechart-'));try{
  let calls=0;const fetcher=async()=>{calls++;throw Error('page unavailable');};
  const a=await checkMonitoringDaily(directory,NOW,{fetcher});assert.equal(a.status,'unknown');await checkMonitoringDaily(directory,NOW+1000,{fetcher});assert.equal(calls,1);
  await checkMonitoringDaily(directory,NOW+DAY,{fetcher});assert.equal(calls,2);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('paper-only transport rejects account/order endpoints and only sends GET without auth',async()=>{
 const calls=[],market=new FadeChartPublicData({fetcher:async(u,o)=>{calls.push([u.toString(),o]);return {ok:true,json:async()=>[]};}});
 await market.candles('AAAUSDT','15m',150);assert.match(calls[0][0],/limit=150/);assert.equal(calls[0][1].method,'GET');assert.equal(calls[0][1].headers,undefined);
 for(const path of ['/fapi/v1/order','/fapi/v1/algoOrder','/fapi/v3/account'])await assert.rejects(market.get(path),/not allowed/);
 assert.equal(calls.length,1);
});
test('paper ledger sizes risk flags, six-hour dedup survives restart and component reports retain evidence',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'fadechart-'));let now=NOW;
 try{
  const p=new FadeChartPaper({directory,now:()=>now});await p.initialize();const score=get_score('AAAUSDT',fixture());
  // Use a nearer, still structural stop for this ledger-only risk test.
  score.stop=99;const one=await p.open(score,{bidPrice:97,askPrice:97.01});assert.equal(one.opened,true,one.reason);assert.ok(one.position.plannedRisk<=.5+1e-9);
  assert.equal((await p.open(score,{bidPrice:97,askPrice:97.01})).opened,false);
  await p.close(one.position,96,'TEST',now);const restarted=new FadeChartPaper({directory,now:()=>now});await restarted.initialize();
  assert.equal((await restarted.open(score,{bidPrice:97,askPrice:97.01})).opened,false);assert.ok(restarted.state.closed[0].score.components.monitoring_tag);
  now+=6*3600000;assert.equal((await restarted.open(score,{bidPrice:97,askPrice:97.01})).opened,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('stop above 8% is skipped after real quote/entry slip; same-bar stop wins over target',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'fadechart-'));let now=NOW;
 try{
  const p=new FadeChartPaper({directory,now:()=>now});await p.initialize();let s={...get_score('AAAUSDT',fixture()),stop:106};
  assert.equal((await p.open(s,{bidPrice:97,askPrice:97.01})).opened,false);
  s.stop=99;const r=await p.open(s,{bidPrice:97,askPrice:97.01});assert.equal(r.opened,true);
  now+=124000;const t=Math.ceil(NOW/60000)*60000;
  p.market={candles:async()=>[[t,97,100,80,95,10,t+59999]],book:async()=>{throw Error('already closed by candle');}};
  await p.manage();assert.equal(p.state.closed[0].reason,'STOP');assert.ok(p.state.closed[0].net<0);
  assert.ok(p.state.closed[0].exit>99,'adverse exit slippage included');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('invalid state never resets virtual history; Monitoring expiry and Telegram status are explicit',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'fadechart-'));try{
  const file=join(directory,'monitoring.json');await writeFile(file,JSON.stringify({complete:true,symbols:['AAA'],sources:['https://www.binance.com/en/markets'],checkedAt:NOW}));
  assert.equal((await monitoringSnapshot(file,NOW)).status,'verified');assert.equal((await monitoringSnapshot(file,NOW+DAY)).status,'unknown');
  assert.match(await fadeChartStatus(),/Not configured/);await writeFile(join(directory,'state.json'),'invalid');const p=new FadeChartPaper({directory});await assert.rejects(p.initialize());assert.equal(await readFile(join(directory,'state.json'),'utf8'),'invalid');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('worker scans only pumped perpetuals, requests 150 15m bars and never replays the same entry after restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'fadechart-'));try{
  const x=fixture(),calls=[];await writeFile(join(directory,'monitoring.json'),JSON.stringify({complete:true,symbols:['AAA'],sources:['https://www.binance.com/en/markets/coinInfo-Monitoring'],checkedAt:NOW}));
  const market={info:async()=>({symbols:[{symbol:'AAAUSDT',baseAsset:'AAA',status:'TRADING',quoteAsset:'USDT',marginAsset:'USDT',contractType:'PERPETUAL',onboardDate:NOW-10*DAY}]}),tickers:async()=>[x.ticker,{symbol:'NOUSDT',lastPrice:100,lowPrice:90}],candles:async(s,i,n)=>{calls.push([s,i,n]);return i==='15m'?x.rows:i==='1d'?x.dailyRows:bars(10,60000);},book:async()=>({bidPrice:97,askPrice:97.01})};
  const p=new FadeChartPaper({directory,market,now:()=>NOW});await p.initialize();await p.tick();assert.equal(p.state.lastError,null);assert.equal(p.state.positions.length,1);
  assert.ok(calls.some(([s,i,n])=>s==='AAAUSDT'&&i==='15m'&&n===150));assert.equal(calls.some(([s])=>s==='NOUSDT'),false);
  const restarted=new FadeChartPaper({directory,market,now:()=>NOW});await restarted.initialize();await restarted.tick();assert.equal(restarted.state.positions.length,1);
  const lines=(await readFile(join(directory,'2026-10-31.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(lines.filter(r=>r.kind==='OPEN').length,1);assert.equal(lines.filter(r=>r.kind==='SCORE').length,1);assert.equal(Object.keys(lines.find(r=>r.kind==='SCORE').score.components).length,15);
  assert.match(await fadeChartStatus(join(directory,'state.json')),/SIMULATION ONLY/);
 }finally{await rm(directory,{recursive:true,force:true});}
});
