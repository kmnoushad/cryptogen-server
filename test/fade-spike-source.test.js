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
  assert.equal(symbols.length,740);assert.equal(streams.length,16);
  assert.ok(streams.every(s=>s.names.length<=101));
  const names=streams.flatMap(s=>s.names);assert.equal(new Set(names).size,names.length);
  assert.equal(names.filter(n=>n==='btcusdt@aggTrade').length,1);
  for(const symbol of symbols) {
    assert.ok(names.includes(symbol.toLowerCase()+'@aggTrade'));
    assert.ok(names.includes(symbol.toLowerCase()+'@bookTicker'));
  }
});
function fixture() {
  let time=1000000,id=0,paused=false;
  const source=new FadeSpikeSource({now:()=>time,environment:'live',isPaused:()=>paused});
  source.detector=new SpikeFadeDetector({symbols:['AAAUSDT'],now:()=>time});
  source.connected=new Set(['market','public']);
  source.btc=Array.from({length:901},(_,i)=>({time:time-900000+i*1000,price:100}));
  const feed=(price,qty=1,sell=false)=>{
    time+=1000;source.ingest({e:'aggTrade',s:'BTCUSDT',T:time,p:'100'});
    source.ingest({e:'bookTicker',s:'AAAUSDT',T:time,b:String(price),a:String(price*1.0001)});
    source.ingest({e:'aggTrade',s:'AAAUSDT',a:++id,T:time,p:String(price),q:String(qty),m:sell});
  };
  for(let i=0;i<145;i++) feed(100);
  return {source,feed,pause:()=>{paused=true;},advance:ms=>{time+=ms;}};
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
  assert.match(h.source.health(),/ready 1/);
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
