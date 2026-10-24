import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export class BinanceBackoff extends Error {
  constructor(until, now, reason) {
    super(`Binance requests deferred: ${reason}; retry in ${Math.max(1, Math.ceil((until-now)/1000))}s`);
    this.status=429; this.code=-1003; this.retryAfterMs=Math.max(1,until-now); this.requestSent=false;
  }
}
export function requestWeight(route, params={}) {
  if(/\/(income|allOrders|userTrades|allAlgoOrders|commissionRate)$/.test(route))return 30;
  if(route.endsWith('/openOrders'))return params.symbol ? 1 : 40;
  if(route.endsWith('/openAlgoOrders'))return params.symbol ? 1 : 40;
  if(route.endsWith('/ticker/24hr'))return params.symbol ? 1 : 40;
  if(route.endsWith('/ticker/bookTicker'))return params.symbol ? 2 : 5;
  if(route.endsWith('/klines'))return Number(params.limit??500)<100 ? 1 : Number(params.limit??500)<500 ? 2 : 10;
  if(route.endsWith('/depth'))return 5;
  if(/\/(account|positionRisk|allOrders|userTrades|allAlgoOrders|symbolConfig|commissionRate)$/.test(route))return 5;
  if(route.endsWith('/premiumIndex'))return params.symbol ? 1 : 10;
  return 1;
}
export function protectionRequest(method, route, params={}) {
  if(method==='DELETE')return true;
  if(method==='POST')return String(params.closePosition)==='true'||String(params.reduceOnly)==='true';
  return /\/(time|account|positionRisk|order|algoOrder|openOrders|openAlgoOrders)$/.test(route);
}

// Shared across services despite PrivateTmp. Directory is provisioned by the
// installer; no API keys, URLs, symbols or account data are saved here.
export class BinanceRequestBudget {
  constructor({directory, environment='live', now=()=>Date.now()}) {
    this.directory=directory; this.now=now;
    this.file=path.join(directory,`${environment}.json`);this.lock=this.file+'.lock';this.queue=Promise.resolve();
  }
  transaction(update) {
    const task=this.queue.then(async()=>{
      const started=Date.now(),deadline=started+2000;
      let handle,lastReap=started;
      while(handle===undefined) {
        try {
          handle=fs.openSync(this.lock,'wx',0o600);
          try {fs.writeFileSync(handle,String(process.pid));}
          catch(error){fs.closeSync(handle);fs.unlinkSync(this.lock);handle=undefined;throw error;}
        } catch(e) {
          if(e.code!=='EEXIST')throw Error('Shared Binance request budget unavailable; requests withheld');
          // Do not create/delete a reaper file on every poll. Live workers
          // normally release this tiny critical section before the next poll.
          if(Date.now()-lastReap>=500) {
            lastReap=Date.now();let reaper;
            try {
              reaper=fs.openSync(this.lock+'.reaper','wx',0o600);
              const pid=Number(fs.readFileSync(this.lock,'utf8'));
              if(Number.isInteger(pid)&&pid>0) {
                try {process.kill(pid,0);} catch(err) {if(err.code==='ESRCH')fs.unlinkSync(this.lock);}
              }
            } catch {} finally {if(reaper!==undefined){fs.closeSync(reaper);fs.unlinkSync(this.lock+'.reaper');}}
          }
          if(Date.now()>=deadline)throw Error('Shared Binance request budget busy after 2s; requests withheld');
          await delay(25+Math.floor(Math.random()*25));
        }
      }
      // No await while holding the cross-process lock: avoid callback/threadpool
      // scheduling stretching a few hundred bytes of local I/O into seconds.
      try {
        const now=this.now();let state;
        try {state=JSON.parse(fs.readFileSync(this.file,'utf8'));}
        catch(e) {if(e.code!=='ENOENT')throw Error('Shared Binance request budget invalid; requests withheld');state={};}
        if(state.minute!==Math.floor(now/60000))state={...state,minute:Math.floor(now/60000),used:0};
        if(!Number.isFinite(state.used)||state.used<0||!Number.isFinite(state.blockedUntil??0))throw Error('Shared Binance request budget invalid; requests withheld');
        const result=update(state,now);
        if(result?.then)throw Error('Shared Binance budget update must be synchronous');
        const temp=this.file+`.${process.pid}.tmp`;
        fs.writeFileSync(temp,JSON.stringify(state),{mode:0o600});fs.renameSync(temp,this.file);
        return result;
      } finally {fs.closeSync(handle);fs.unlinkSync(this.lock);}

    });
    this.queue=task.catch(()=>{});return task;
  }
  async before(method,route,params) {
    const blocked=await this.transaction((s,now)=>{
      if((s.blockedUntil??0)>now)return new BinanceBackoff(s.blockedUntil,now,'exchange cooldown');
      const limit=Math.min(protectionRequest(method,route,params)?1800:1200,Math.floor((s.limit??2400)*(protectionRequest(method,route,params)?0.9:0.7)));
      const cost=requestWeight(route,params);
      if(s.used+cost>limit)return new BinanceBackoff((s.minute+1)*60000+1000,now,'shared request-weight budget');
      s.used+=cost;return null;
    });
    if(blocked)throw blocked;
  }
  async observe(response, body) {
    await this.transaction((s,now)=>{
      const weight=Number(response.headers?.get?.('x-mbx-used-weight-1m'));
      // An older response must not reset the reservation count.
      if(Number.isFinite(weight)&&weight>0)s.used=Math.max(s.used,weight);
      const declared=body?.rateLimits?.find?.(r=>r.rateLimitType==='REQUEST_WEIGHT'&&r.interval==='MINUTE'&&r.intervalNum===1)?.limit;
      if(Number.isFinite(declared)&&declared>0)s.limit=declared;
      if([429,418].includes(response.status)||body?.code===-1003) {
        const raw=response.headers?.get?.('retry-after');const seconds=Number(raw);
        const retry=raw && Number.isFinite(seconds)&&seconds>0 ? now+seconds*1000 : raw&&Number.isFinite(Date.parse(raw)) ? Date.parse(raw) : now+(response.status===418?180000:60000);
        const ban=String(body?.msg??'').match(/banned until\s+(\d{13})/i);
        s.blockedUntil=Math.max(s.blockedUntil??0,retry,ban?Number(ban[1]):0)+1000;
      }
    });
  }
}
export const createRequestBudget = environment => process.env.NEXIO_BINANCE_BUDGET_DIR
  ? new BinanceRequestBudget({directory:process.env.NEXIO_BINANCE_BUDGET_DIR,environment}) : null;
