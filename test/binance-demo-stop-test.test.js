import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DEMO_BASE,demoConfig,preflight,scenario,cleanup,validateJournal } from '../scripts/binance-demo-stop-test.js';
import { ExchangeError } from '../src/fade-orders.js';
const env={NEXIO_DEMO_API_KEY:'demo-key',NEXIO_DEMO_API_SECRET:'demo-secret',NEXIO_DEMO_CONFIRMATION:'DEMO_ONLY_NO_REAL_FUNDS'};
const f={step:.001,tick:.01,min:.001,max:100,notional:5,minPrice:.01,maxPrice:100000};
function harness(opt={}){
 let amount=0;const orders=new Map(),algos=new Map(),calls=[];let saved;
 const ex={base:DEMO_BASE,syncTime:async()=>{},mode:async()=>({dualSidePosition:opt.hedge??false}),assetsMode:async()=>({multiAssetsMargin:false}),accountPermissions:async()=>({canTrade:true}),
  positions:async()=>amount?[{symbol:'ETHUSDT',positionSide:'BOTH',positionAmt:String(amount)}]:[],
  orders:async()=>[...orders.values()].filter(o=>o.status==='NEW'),algos:async()=>[...algos.values()].filter(o=>o.algoStatus==='NEW'),
  info:async()=>({symbols:[{symbol:'ETHUSDT',status:'TRADING',quoteAsset:'USDT',contractType:'PERPETUAL',filters:[{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100'},{filterType:'MARKET_LOT_SIZE',stepSize:'.001',minQty:'.001',maxQty:'100'},{filterType:'PRICE_FILTER',tickSize:'.01',minPrice:'.01',maxPrice:'100000'},{filterType:'MIN_NOTIONAL',notional:'5'}]}]}),
  book:async()=>({bidPrice:'100',askPrice:'100.01'}),
  order:async(symbol,id)=>{if(!orders.has(id))throw new ExchangeError(400,-2013);return structuredClone(orders.get(id));},
  algo:async id=>{if(!algos.has(id))throw new ExchangeError(400,-2013);return structuredClone(algos.get(id));},
  place:async p=>{calls.push(['order',p]);assert.ok(saved.actions && Object.values(saved.actions).some(a=>a.id===p.newClientOrderId),'journal before send');if(opt.unknownEntry&&!p.reduceOnly)throw Error('unknown send');if(opt.rejectEntry&&!p.reduceOnly)throw new ExchangeError(400,-2019);
   const qty=Number(p.quantity),market=p.type==='MARKET';const o={...p,clientOrderId:p.newClientOrderId,status:market?'FILLED':'NEW',origQty:p.quantity,executedQty:market?p.quantity:'0'};orders.set(o.clientOrderId,o);
   if(market)amount=p.reduceOnly?(Math.sign(amount)*Math.max(0,Math.abs(amount)-qty)||0):(p.side==='BUY'?qty:-qty);
   if(opt.lostEntry&&!p.reduceOnly){opt.lostEntry=false;throw Error('unknown response');}return o;},
  placeDirectionalStop:async(symbol,id,price,side,qty)=>{calls.push(['stop',id]);assert.ok(Object.values(saved.actions).some(a=>a.id===id),'journal before stop');
   if(qty!=null&&opt.rejectReplacement)throw new ExchangeError(400,-2022);
   if(qty==null&&[...algos.values()].some(o=>o.algoStatus==='NEW'&&o.closePosition&&o.side===side))throw new ExchangeError(400,-4130);
   const o={symbol,clientAlgoId:id,triggerPrice:String(price),side,orderType:'STOP_MARKET',positionSide:'BOTH',algoStatus:'NEW',...(qty==null?{closePosition:true}:{closePosition:false,reduceOnly:true,quantity:String(qty)})};algos.set(id,o);return o;},
  placeStop:async(symbol,id,price,qty)=>ex.placeDirectionalStop(symbol,id,price,'BUY',qty),
  cancel:async(symbol,id)=>{const o=orders.get(id);if(!o||o.status!=='NEW')throw new ExchangeError(400,-2011);o.status='CANCELED';calls.push(['cancel',id]);},
  cancelStop:async id=>{const o=algos.get(id);if(!o||o.algoStatus!=='NEW')throw new ExchangeError(400,-2011);o.algoStatus='CANCELED';calls.push(['cancelStop',id]);},
 };
 const job={profile:'futures',direction:'LONG',symbol:'ETHUSDT',prefix:'ndt-0123456789-0',filters:f,entryQty:0,actions:{}};
 return {ex,job,calls,orders,algos,opt,qty:()=>amount,persist:async()=>{saved=structuredClone(job);},wait:async()=>{}};
}
test('configuration defaults to check, requires dedicated demo keys and acknowledgement for writes',()=>{
 assert.equal(demoConfig(env).command,'--check');assert.equal(demoConfig(env,['--apply']).command,'--apply');
 assert.throws(()=>demoConfig({...env,BINANCE_API_KEY:'live'}),/credential variables/);
 assert.throws(()=>demoConfig({...env,NEXIO_DEMO_CONFIRMATION:''},['--apply']),/acknowledgement/);
 assert.throws(()=>demoConfig(env,['--live']),/Use|Invalid/);
});
test('read-only preflight never submits orders and refuses live endpoint, hedge mode or existing orders',async()=>{
 const h=harness();await preflight(h.ex,'ETHUSDT');assert.equal(h.calls.length,0);
 h.ex.base='https://fapi.binance.com';await assert.rejects(preflight(h.ex,'ETHUSDT'),/Demo endpoint/);assert.equal(h.calls.length,0);
 const hedge=harness({hedge:true});await assert.rejects(preflight(hedge.ex,'ETHUSDT'),/One-way/);
 const busy=harness();busy.orders.set('manual',{status:'NEW'});await assert.rejects(preflight(busy.ex,'ETHUSDT'),/dedicated flat/);
});
for(const [profile,direction] of [['futures','LONG'],['futures','SHORT'],['fade','SHORT']])test(`${profile} ${direction}: verified replacement precedes cancellation; cleanup ends flat`,async()=>{
 const h=harness();Object.assign(h.job,{profile,direction});await scenario(h.ex,h.job,h.persist,{wait:h.wait,log:()=>{}});
 assert.equal(h.job.passed,true);const stops=[...h.algos.values()];assert.equal(stops.filter(o=>o.closePosition).length,1);assert.ok(stops.some(o=>o.reduceOnly));
 assert.ok(h.calls.findIndex(c=>c[0]==='cancelStop'&&c[1].endsWith('-old'))>h.calls.findIndex(c=>c[0]==='stop'&&c[1].endsWith('-new')));
 if(profile==='fade')assert.ok(Number(h.algos.get(h.job.prefix+'-trail').quantity)<Number(h.algos.get(h.job.prefix+'-new').quantity));
 await cleanup(h.ex,h.job,h.persist,h.wait);assert.equal(h.qty(),0);assert.equal((await h.ex.algos()).length,0);assert.equal((await h.ex.orders()).length,0);
});
test('lost market-entry response is recovered by ID without another entry',async()=>{
 const h=harness({lostEntry:true});await scenario(h.ex,h.job,h.persist,{wait:h.wait,log:()=>{}});
 assert.equal(h.calls.filter(c=>c[0]==='order'&&!c[1].reduceOnly).length,1);await cleanup(h.ex,h.job,h.persist,h.wait);
});
test('replacement rejection retains original stop until reduce-only cleanup proves flatness',async()=>{
 const h=harness({rejectReplacement:true});await assert.rejects(scenario(h.ex,h.job,h.persist,{wait:h.wait,log:()=>{}}),e=>e.code===-2022);
 assert.equal(h.algos.get(h.job.prefix+'-old').algoStatus,'NEW');assert.notEqual(h.qty(),0);
 await cleanup(h.ex,h.job,h.persist,h.wait);assert.equal(h.qty(),0);assert.equal(h.job.cleaned,true);
});
test('entry rejection creates no position and no cleanup market order',async()=>{
 const h=harness({rejectEntry:true});await assert.rejects(scenario(h.ex,h.job,h.persist,{wait:h.wait,log:()=>{}}),e=>e.code===-2019);
 await cleanup(h.ex,h.job,h.persist,h.wait);assert.equal(h.qty(),0);assert.equal(h.calls.filter(c=>c[0]==='order').length,1);
});
test('recovery rejects foreign endpoint and invalid journal identity',()=>{
 const h=harness(),state={schema:1,runId:'0123456789',endpoint:DEMO_BASE,credentialFingerprint:createHash('sha256').update(env.NEXIO_DEMO_API_KEY).digest('hex'),jobs:[h.job]};
 validateJournal(state);assert.throws(()=>validateJournal({...state,endpoint:'https://fapi.binance.com'}),/Invalid/);
 h.job.actions.bad={id:'manual',kind:'stop'};assert.throws(()=>validateJournal(state),/Invalid/);
});

test('unknown entry absence remains unresolved and never permits a second entry or false cleanup pass',async()=>{
 const h=harness({unknownEntry:true});await assert.rejects(scenario(h.ex,h.job,h.persist,{wait:h.wait,log:()=>{}}));
 await assert.rejects(cleanup(h.ex,h.job,h.persist,h.wait));assert.notEqual(h.job.cleaned,true);
 assert.equal(h.calls.filter(c=>c[0]==='order'&&!c[1].reduceOnly).length,1);
});
