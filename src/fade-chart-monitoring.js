import {readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
const SOURCE='https://www.binance.com/en/markets/coinInfo-Monitoring',DAY=86400000;
// The website is not a versioned API. Accept ONLY explicit per-token Monitoring
// tags in embedded JSON, never a navigation label or an unscoped ticker list.
// Partial lists prove positives only; absence is always unknown.
export function monitoringTokens(html){
 const symbols=new Set();let visited=0;
 const walk=(v,depth=0)=>{
  if(!v||typeof v!=='object'||depth>30||++visited>100000)return;
  const tagList=v.tags??v.tagList??v.tagInfos;
  const tags=Array.isArray(tagList)?tagList.map(t=>typeof t==='string'?t:t?.name??t?.tagName):[];
  const asset=v.baseAsset??v.asset??v.symbol;
  if(tags.some(t=>t==='Monitoring')&&typeof asset==='string'&&/^[A-Z0-9]{1,30}$/.test(asset))symbols.add(asset);
  for(const x of Object.values(v))walk(x,depth+1);
 };
 for(const s of html.matchAll(/<script\b[^>]*(?:type=["']application\/json["']|id=["']__APP_DATA["'])[^>]*>([\s\S]*?)<\/script>/gi))try{walk(JSON.parse(s[1]));}catch{}
 return [...symbols].sort();
}
export async function checkMonitoringDaily(directory,now,{fetcher=fetch}={}){
 const path=join(directory,'monitoring-auto.json');
 try{const d=JSON.parse(await readFile(path,'utf8'));if(Number.isFinite(d.checkedAt)&&now-d.checkedAt>=0&&now-d.checkedAt<DAY)return d;}catch{}
 let d={checkedAt:now,source:SOURCE,status:'unknown',symbols:[],reason:'Official page schema unavailable; reviewed daily snapshot needed'};
 try{
  const r=await fetcher(SOURCE,{method:'GET',redirect:'error',signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw Error(`Monitoring page HTTP ${r.status}`);
  const html=await r.text();if(html.length>10_000_000)throw Error('Monitoring page oversized');
  const symbols=monitoringTokens(html);
  if(symbols.length)d={...d,status:'verified-positives-only',symbols,reason:'Explicit token tags; unlisted tokens remain unknown'};
 }catch(e){d.reason=e.message;}
 await writeFile(path+'.tmp',JSON.stringify(d),{mode:0o600});await rename(path+'.tmp',path);return d;
}
