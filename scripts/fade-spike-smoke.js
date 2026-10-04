// Read-only target-host check. There is no executor or order API call.
import { loadFadeConfig } from '../src/fade-config.js';
import { FadeExchange } from '../src/fade-orders.js';
import { FadeSpikeSource } from '../src/fade-spike-source.js';
const cfg=loadFadeConfig();
const source=new FadeSpikeSource({environment:cfg.fadeEnvironment,isPaused:()=>true,
  exchange:new FadeExchange({key:cfg.binanceApiKey,secret:cfg.binanceApiSecret,environment:cfg.fadeEnvironment})});
try {
  await source.start();
  const deadline=Date.now()+25000;
  let received=false;
  while(Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,500));
    const latest=source.btc.at(-1);
    if(source.connected.size===2 && latest && Date.now()-latest.time<2000
      && [...source.books.values()].some(b=>Date.now()-b.at<1000)) {received=true;break;}
  }
  if(!received) throw Error('Fresh BTC trade and symbol book streams not received');
  console.log(`Spike read-only smoke passed: ${source.detector.symbols.size} eligible symbols; fresh BTC trades and bid/ask received. No orders placed.`);
} catch(error) {
  console.error(`Spike read-only smoke failed: ${error.message}`);process.exitCode=1;
} finally {source.stop();}
