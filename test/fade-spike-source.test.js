import test from 'node:test';
import assert from 'node:assert/strict';
import { FadeSpikeSource, spikeContracts, spikeSubscriptions } from '../src/fade-spike-source.js';
import { SpikeFadeDetector } from '../src/spike-fade-detector.js';
import { fadeSpikeBtcGate } from '../src/fade-btc-gate.js';
test('full universe includes 740 coin contracts and shards every subscription without a volume filter',()=>{
  const make=symbol=>({symbol,status:'TRADING',quoteAsset:'USDT',contractType:'PERPETUAL',underlyingType:'COIN'});
  const info={symbols:Array.from({length:740},(_,i)=>make(`SMALL${i}USDT`))};
  info.symbols.push(make('BTCUSDT'),{...make('HALTEDUSDT'),status:'SETTLING'},
    {...make('STOCKUSDT'),underlyingType:'INDEX'}, {...make('USDCOINUSDC'),quoteAsset:'USDC'});
  const symbols=spikeContracts(info),streams=spikeSubscriptions(symbols);
  assert.equal(symbols.length,740);assert.equal(streams.length,17);
  assert.ok(streams.every(s=>s.names.length<=50));
  const names=streams.flatMap(s=>s.names);assert.equal(new Set(names).size,names.length);
  assert.equal(names.filter(n=>n==='btcusdt@aggTrade').length,1);
  for(const symbol of symbols) {
    assert.ok(names.includes(symbol.toLowerCase()+'@aggTrade'));
    assert.equal(names.includes(symbol.toLowerCase()+'@bookTicker'),symbol===symbols[0]);
  }
});
function fixture() {
  let time=1000000,id=0,paused=false;
  const source=new FadeSpikeSource({now:()=>time,environment:'live',isPaused:()=>paused});
  source.detector=new SpikeFadeDetector({symbols:['AAAUSDT'],now:()=>time});
  source.requiredConnections=3;
  source.connected=new Set(['market:btc','market:0','public:probe']);
  source.symbolStreams.set('AAAUSDT',{market:'market:0',book:'public:probe'});
  source.btc=Array.from({length:901},(_,i)=>({time:time-900000+i*1000,price:100}));
  const feed=(price,qty=1,sell=false)=>{
    time+=1000;source.ingest({e:'aggTrade',s:'BTCUSDT',T:time,p:'100'},'market:btc');
    source.ingest({e:'bookTicker',s:'AAAUSDT',T:time,b:String(price),a:String(price*1.0001)},'public:probe');
    source.ingest({e:'aggTrade',s:'AAAUSDT',a:++id,T:time,p:String(price),q:String(qty),m:sell},'market:0');
  };
  for(let i=0;i<145;i++) feed(100);
  return {source,feed,pause:()=>{paused=true;},advance:ms=>{time+=ms;},now:()=>time};
}
test('fresh tick candidate wakes worker once, drains once and is fenced by generation',()=>{
  const h=fixture();let wakes=0;h.source.onCandidate=()=>wakes++;
  h.feed(103,100);h.feed(103,100,true);h.feed(102.8,100,true);h.feed(102.4,100,true);
  assert.equal(wakes,1);const [s]=h.source.drain();assert.equal(h.source.authorize(s.symbol,s),true);
  assert.deepEqual(h.source.drain(),[]);h.source.clear();assert.equal(h.source.authorize(s.symbol,s),false);
});
test('candidate expiry is exposed with a specific source-side block reason',()=>{
  const h=fixture();h.feed(103,100);h.feed(103,100,true);h.feed(102.8,100,true);h.feed(102.4,100,true);
  const [s]=h.source.drain();assert.ok(s);h.advance(11000);
  assert.equal(h.source.authorize(s.symbol,s),false);
  assert.match(h.source.health(),/last AAAUSDT blocked: candidate expired/);
  assert.match(h.source.health(),/quote-ready symbols 0/);
});
test('stale book, pause, disconnect and rising BTC invalidate unsent signal',()=>{
  for(const change of [h=>h.advance(1100),h=>h.pause(),h=>h.source.connected.clear(),
    h=>{h.source.btc.at(-1).price=101;}]) {
    const h=fixture();h.feed(103,100);h.feed(103,100,true);h.feed(102.8,100,true);h.feed(102.4,100,true);
    const [s]=h.source.drain();assert.ok(s);change(h);assert.equal(Boolean(h.source.authorize(s.symbol,s)),false);
  }
});
test('BTC spike gate allows valid flat data but never ignores missing data or upside',()=>{
  const now=10000000,end=Math.floor(now/60000)*60000;
  const rows=Array.from({length:120},(_,i)=>{const t=end-(120-i)*60000;return[t,'100','101','99','100','1',t+59999];});
  assert.equal(fadeSpikeBtcGate(rows,{bidPrice:'99.99',askPrice:'100'},now).allowed,true);
  assert.equal(fadeSpikeBtcGate(rows,{bidPrice:'100.2',askPrice:'100.21'},now).allowed,false);
  assert.equal(fadeSpikeBtcGate([],{},now).allowed,false);
});

test('one disconnected market shard only resets its own symbols',()=>{
  let time=1000000;
  const symbols=Array.from({length:101},(_,i)=>`A${String(i).padStart(3,'0')}USDT`);
  const source=new FadeSpikeSource({now:()=>time,environment:'live',isPaused:()=>false,
    schedule:(fn,ms)=>({fn,ms,unref(){}}),cancel:()=>{}});
  source.detector=new SpikeFadeDetector({symbols,now:()=>time});
  const streams=spikeSubscriptions(symbols);source.streams=new Map(streams.map(s=>[s.key,s]));
  source.requiredConnections=streams.length;source.connected=new Set(streams.map(s=>s.key));
  for(const stream of streams)for(const name of stream.names){const symbol=name.split('@')[0].toUpperCase();
    if(symbol==='BTCUSDT')continue;const pair=source.symbolStreams.get(symbol)??{};
    if(name.endsWith('@aggTrade'))pair.market=stream.key;if(name.endsWith('@bookTicker'))pair.book=stream.key;
    source.symbolStreams.set(symbol,pair);}
  source.btc=Array.from({length:901},(_,i)=>({time:time-900000+i*1000,price:100}));
  source.detector.states.set(symbols[0],{ticks:[{firstTime:time-1000}],time,id:1});
  source.detector.states.set(symbols[100],{ticks:[{firstTime:time-1000}],time,id:1});
  source.books.set(symbols[0],{at:time-1000,bid:100,ask:100.01});
  source.latest.set(symbols[0],{at:time,price:100});
  source.reconnectStream('market:2',source.generation);
  assert.equal(source.ready(symbols[0]),true);assert.equal(source.ready(symbols[100]),false);
  assert.equal(source.detector.states.has(symbols[0]),true);assert.equal(source.detector.states.has(symbols[100]),false);
  time++;
  source.ingest({e:'aggTrade',s:symbols[0],a:2,T:time,p:'100',q:'1',m:false},'market:0');
  assert.equal(source.detector.states.get(symbols[0]).id,2);
});
test('BTC shard reconnect preserves 15m seed but fresh BTC tick is still mandatory',()=>{
  const h=fixture(),source=h.source,seeded=source.btc.length;
  source.reconnectStream('market:btc',source.generation);
  assert.equal(source.connected.has('market:btc'),false);
  assert.equal(source.btc.length,seeded);
  h.advance(5000);assert.equal(source.btcContext(),null);
  source.connected.add('market:btc');
  source.ingest({e:'aggTrade',s:'BTCUSDT',T:h.now(),p:'100'},'market:btc');
  assert.ok(source.btcContext());
});
test('BTC spike gate allows valid flat data but never ignores missing data or upside',()=>{
  const now=10000000,end=Math.floor(now/60000)*60000;
  const rows=Array.from({length:120},(_,i)=>{const t=end-(120-i)*60000;return[t,'100','101','99','100','1',t+59999];});
  assert.equal(fadeSpikeBtcGate(rows,{bidPrice:'99.99',askPrice:'100'},now).allowed,true);
  assert.equal(fadeSpikeBtcGate(rows,{bidPrice:'100.2',askPrice:'100.21'},now).allowed,false);
  assert.equal(fadeSpikeBtcGate([],{},now).allowed,false);
});

test('stream authorization reports the final execution outcome without claiming an order',()=>{
  const h=fixture();h.feed(103,100);h.feed(103,100,true);h.feed(102.8,100,true);h.feed(102.4,100,true);
  const [s]=h.source.drain();assert.equal(h.source.authorize(s.symbol,s),true);
  h.source.recordExecution(s.symbol,s,{reason:'Entry expired or gate changed before order send'});
  assert.match(h.source.health(),/execution checked: Entry expired/);
  h.source.lastCandidate={symbol:'NEWUSDT',detectedAt:s.detectedAt+1,outcome:'queued'};
  h.source.recordExecution(s.symbol,s,{reason:'old result'});
  assert.equal(h.source.lastCandidate.symbol,'NEWUSDT');
});

test('WATCH opens one bounded book feed; expiry closes it without erasing trade baseline',async()=>{
  const {EventEmitter}=await import('node:events');
  const sockets=[];
  class Socket extends EventEmitter {
    constructor(url,options){super();this.url=url;this.options=options;this.readyState=1;sockets.push(this);}
    terminate(){this.readyState=3;this.emit('close');}
  }
  const timers=[];
  const source=new FadeSpikeSource({exchange:{},environment:'live',isPaused:()=>false,WebSocketImpl:Socket,
    schedule:(fn,ms)=>{const t={fn,ms,unref(){}};timers.push(t);return t;},cancel:()=>{}});
  source.detector=new SpikeFadeDetector({symbols:['AAAUSDT']});
  source.streams=new Map([['market:0',{key:'market:0'}]]);
  source.symbolStreams.set('AAAUSDT',{market:'market:0'});
  source.connected.add('market:0');source.requiredConnections=1;
  source.detector.states.set('AAAUSDT',{ticks:[{quote:10}],watch:{high:100}});
  source.ensureWatchBook('AAAUSDT');source.ensureWatchBook('AAAUSDT');
  assert.equal(sockets.length,1);assert.match(sockets[0].url,/public\/stream\?streams=aaausdt@bookTicker$/);
  assert.equal(sockets[0].options.perMessageDeflate,false);
  assert.equal(source.requiredConnections,2);assert.equal(source.watchBookTimers.size,1);
  sockets[0].emit('open');assert.equal(source.connected.has('public:watch:AAAUSDT'),true);
  source.watchBookTimers.get('AAAUSDT').fn();
  assert.equal(source.requiredConnections,1);assert.equal(source.watchBookTimers.size,0);
  assert.equal(source.detector.states.get('AAAUSDT').ticks[0].quote,10);
  assert.equal(source.retryTimers.size,0);
  source.stop();
});

test('stale coin shard data cannot contaminate the dedicated BTC context',()=>{
  const h=fixture(),source=h.source;
  const btcTime=source.btc.at(-1).time;
  source.ingest({e:'aggTrade',s:'BTCUSDT',T:btcTime+1,p:'999'},'market:0');
  assert.equal(source.btc.at(-1).price,100);
  assert.equal(source.btcContext().return30s,0);
  h.advance(3000);
  source.ingest({e:'aggTrade',s:'BTCUSDT',T:h.now()-2500,p:'999'},'market:btc');
  assert.equal(source.btc.at(-1).price,100);assert.equal(source.btcContext(),null);
  assert.ok(source.feedStats.btc.stale>0);
  source.ingest({e:'aggTrade',s:'BTCUSDT',T:h.now(),p:'100'},'market:btc');
  assert.ok(source.btcContext());
});

test('WATCH book capacity is bounded; no quote means no authorization',()=>{
  const h=fixture(),source=h.source;
  source.symbolStreams.set('OTHERUSDT',{market:'market:0'});
  for(let i=0;i<16;i++)source.watchBookTimers.set(`C${i}`,{});
  source.ensureWatchBook('OTHERUSDT');
  assert.equal(source.watchBookTimers.size,16);
  assert.match(source.lastReason,/capacity/);
  assert.equal(source.ready('OTHERUSDT'),false);
});

test('WATCH emits a symbol warm-up callback before an executable candidate',()=>{
 const h=fixture(),events=[];h.source.onWatch=s=>events.push(['watch',s]);h.source.onCandidate=()=>events.push(['candidate']);
 h.feed(103,100);assert.equal(events[0]?.[0],'watch');assert.equal(events.some(x=>x[0]==='candidate'),false);
 h.feed(103,100,true);h.feed(102.8,100,true);h.feed(102.4,100,true);
 assert.equal(events.at(-1)?.[0],'candidate');assert.equal(events[0][1],'AAAUSDT');
});
