// Read-only verification of the endpoints used by v6.9.58. No lease, control,
// leverage, order, cancel or other exchange mutation calls.
import { loadFadeConfig } from '../src/fade-config.js';
import { FadeExchange } from '../src/fade-orders.js';
const cfg=loadFadeConfig();
const exchange=new FadeExchange({key:cfg.binanceApiKey,secret:cfg.binanceApiSecret,environment:cfg.fadeEnvironment});
try {
  await exchange.syncTime();
  const now=Date.now(),symbol='BTCUSDT';
  const results=await Promise.allSettled([
    exchange.depth(symbol),exchange.allOrders(symbol,now-60000,now),
    exchange.trades(symbol,now-60000,now),exchange.algoHistory(symbol,now-60000,now)]);
  for(const result of results)if(result.status==='rejected')throw result.reason;
  const [depth,orders,trades,algos]=results.map(r=>r.value);
  if(!Array.isArray(depth?.bids)||!depth.bids.length||!Array.isArray(depth.asks)||!depth.asks.length
    || !Number.isFinite(Number(depth.T)) || Date.now()-Number(depth.T)>5000)
    throw Error('Depth response missing or delayed');
  if(![orders,trades,algos].every(Array.isArray))throw Error('Reconciliation history response incomplete');
  console.log('Fade v6.9.58 read-only preflight passed: order-book depth and ordinary/algo/fill history reachable.');
  console.log('No orders placed. FOK fills and native-stop acceptance were not tested by this check.');
} catch(error){console.error('Fade execution preflight failed:',error.message);process.exitCode=1;}
