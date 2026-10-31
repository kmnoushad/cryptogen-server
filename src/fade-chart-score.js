// Phase 1B research only. Pure calculations; no exchange/account/order client.
const M15=900000, DAY=86400000;
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
export function series(rows,interval,now){
 if(!Array.isArray(rows))throw Error('Candle data unavailable');
 const a=rows.filter(r=>Number(r[6])<now).map(r=>({time:Number(r[0]),end:Number(r[6]),open:Number(r[1]),high:Number(r[2]),low:Number(r[3]),close:Number(r[4]),volume:Number(r[5])}));
 if(a.some((b,i)=>Object.values(b).some(v=>!Number.isFinite(v))||b.low<=0||b.volume<0||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||b.end-b.time!==interval-1||(i&&b.time-a[i-1].time!==interval)))throw Error('Invalid or discontinuous candles');
 return a;
}
function sma(a,n){return a.map((_,i)=>i<n-1?null:mean(a.slice(i-n+1,i+1)));}
function ema(a,n){let prior;return a.map((x,i)=>{if(i<n-1)return null;if(i===n-1)return prior=mean(a.slice(0,n));return prior=x*2/(n+1)+prior*(1-2/(n+1));});}
export function macd(a){
 const fast=ema(a,12),slow=ema(a,26),line=a.map((_,i)=>slow[i]===null?null:fast[i]-slow[i]);
 const values=ema(line.slice(25),9),signal=line.map((_,i)=>i<25?null:values[i-25]);
 return {line,signal,hist:line.map((v,i)=>signal[i]===null?null:v-signal[i])};
}
export function pivots(a){const out=[];for(let i=2;i<a.length-2;i++)if(a[i].high>a[i-1].high&&a[i].high>a[i-2].high&&a[i].high>=a[i+1].high&&a[i].high>=a[i+2].high)out.push(i);return out;}
export function get_score(symbol,{rows,dailyRows=[],ticker,contract,monitoring,now=Date.now(),threshold=50}={}){
 const names=['pump_100pct','ma7_cross_below_ma25','ma25_rejection','ma_recovery','flat_ma_chop','largest_volume_red','weak_green_bounce','green_volume_breakout','macd_bearish_divergence','macd_cross_down_above_zero','shrinking_histogram_rising_price','upper_wick_near_high','monitoring_tag','down_70pct_180d','listed_under_30d'];
 const components=Object.fromEntries(names.map(name=>[name,{points:0,active:null,metrics:{status:'not evaluated'}}]));const add=(name,points,active,metrics={})=>{components[name]={points:active===true?points:0,active:active??null,metrics};};
 const out={model:'fade-chart-paper-v1',symbol,mode:'SIMULATION',executable:false,allowed:false,components,threshold};
 try{
  if(!/^[A-Z0-9]+USDT$/.test(symbol)||!Number.isFinite(threshold)||threshold<0||threshold>150)throw Error('Invalid symbol/score threshold');
  const a=series(rows,M15,now);if(a.length<120)throw Error('Need 120 closed 15m candles');
  const last=a.at(-1),prev=a.at(-2),n=a.length-1;
  out.barCloseTime=last.end;
  if(last.end!==Math.floor(now/M15)*M15-1)throw Error('Latest closed 15m candle missing');
  const low=Number(ticker?.lowPrice),current=Number(ticker?.lastPrice),tickerAt=Number(ticker?.observedAt);
  if(ticker?.symbol!==symbol||![low,current,tickerAt].every(Number.isFinite)||low<=0||current<low||now-tickerAt<0||now-tickerAt>60000)throw Error('Ticker unavailable/stale');
  out.pumpPct=(current/low-1)*100;out.closedPumpPct=(last.close/low-1)*100;
  const pumped=current>=2*low&&last.close>=2*low;
  add('pump_100pct',0,pumped,{pumpPct:out.pumpPct,closedPumpPct:out.closedPumpPct,low24h:low});
  const close=a.map(b=>b.close),ma7=sma(close,7),ma25=sma(close,25),ma99=sma(close,99);
  const pumpIndex=a.findIndex(b=>b.close>=2*low);
  const crosses=[];for(let i=Math.max(99,n-19);i<=n;i++)if(i>=pumpIndex&&ma7[i-1]>=ma25[i-1]&&ma7[i]<ma25[i])crosses.push(i);
  add('ma7_cross_below_ma25',15,pumped&&crosses.length>0,{crossTimes:crosses.map(i=>a[i].end),ma7:ma7[n],ma25:ma25[n],ma99:ma99[n]});
  add('ma25_rejection',15,prev.close<ma25[n-1]&&last.high>ma25[n]&&Math.max(last.open,last.close)<ma25[n],{ma25:ma25[n]});
  const recovery=last.close>ma25[n]&&ma7[n-1]<=ma25[n-1]&&ma7[n]>ma25[n];
  add('ma_recovery',-20,recovery);
  const gapPct=Math.abs(ma7[n]/ma25[n]-1)*100,slope7=Math.abs(ma7[n]/ma7[n-3]-1)*100,slope25=Math.abs(ma25[n]/ma25[n-3]-1)*100;
  add('flat_ma_chop',-10,gapPct<.5&&slope7<=.1&&slope25<=.1,{gapPct,slope7Pct:slope7,slope25Pct:slope25,flatMaxPct:.1});
  const recent=a.slice(-20),big=recent.reduce((x,b)=>b.volume>=x.volume?b:x),reds=recent.filter(b=>b.close<b.open),red=reds.length?reds.reduce((x,b)=>b.volume>=x.volume?b:x):null;
  add('largest_volume_red',10,big.close<big.open&&big.volume>0,{time:big.end,volume:big.volume});
  const bounces=red?recent.filter(b=>b.time>red.time&&b.close>b.open):[];
  add('weak_green_bounce',10,!!red&&bounces.length>0&&bounces.every(b=>b.volume<.5*red.volume),{redVolume:red?.volume??null,bounceVolumes:bounces.map(b=>b.volume)});
  add('green_volume_breakout',-15,!!red&&last.close>last.open&&last.close>Math.max(...a.slice(-6,-1).map(b=>b.high))&&last.volume>red.volume,{redVolume:red?.volume??null,triggerVolume:last.volume});
  const m=macd(close),peaks=pivots(a).filter(i=>i>=n-40),p2=peaks.at(-1),p1=peaks.slice(0,-1).filter(i=>p2-i>=3).at(-1);
  add('macd_bearish_divergence',15,p1!==undefined&&p2!==undefined&&n-p2<=10&&a[p2].high>a[p1].high&&m.line[p2]<m.line[p1],{first:p1===undefined?null:{time:a[p1].end,high:a[p1].high,macd:m.line[p1]},second:p2===undefined?null:{time:a[p2].end,high:a[p2].high,macd:m.line[p2]}});
  add('macd_cross_down_above_zero',10,m.line[n-1]>=m.signal[n-1]&&m.line[n]<m.signal[n]&&m.line[n]>0&&m.signal[n]>0,{macd:m.line[n],signal:m.signal[n]});
  add('shrinking_histogram_rising_price',5,close[n]>close[n-1]&&close[n-1]>close[n-2]&&m.hist[n-2]>m.hist[n-1]&&m.hist[n-1]>m.hist[n]&&m.hist[n]>0,{histogram:m.hist.slice(-3)});
  const localHigh=Math.max(...recent.map(b=>b.high));
  add('upper_wick_near_high',10,a.slice(-3).some(b=>b.high>=localHigh*.98&&b.high>b.low&&(b.high-Math.max(b.open,b.close))/(b.high-b.low)>.5),{localHigh,nearHighPct:2});
  const tagFresh=monitoring?.status==='verified'&&Number.isFinite(monitoring.checkedAt)&&now-monitoring.checkedAt>=0&&now-monitoring.checkedAt<DAY;
  const tagged=tagFresh?monitoring.tagged===true:null;
  add('monitoring_tag',10,tagged,{status:tagFresh?'verified':'unknown',source:monitoring?.source??null,checkedAt:monitoring?.checkedAt??null});
  let decline=null,dailyStatus='unavailable';try{const d=series(dailyRows,DAY,now);if(d.length>=181&&d.at(-1).end===Math.floor(now/DAY)*DAY-1){decline=(1-d.at(-1).close/d.at(-181).close)*100;dailyStatus='available';}}catch{dailyStatus='invalid';}
  add('down_70pct_180d',10,decline===null?null:decline>70,{declinePct:decline,status:dailyStatus});
  const onboard=Number(contract?.onboardDate),age=Number.isFinite(onboard)&&onboard>0&&onboard<=now?(now-onboard)/DAY:null;
  add('listed_under_30d',5,age===null?null:age<30,{contractAgeDays:age});
  out.sizeMultiplier=Math.min((tagged===true||tagged===null) ? .5 : 1,(age===null||age<30) ? .5 : 1);
  out.score=Object.values(components).reduce((sum,c)=>sum+c.points,0);
  // A wick/score is insufficient: fresh bearish CLOSE through two prior lows.
  out.confirmation={confirmed:last.close<last.open&&last.close<Math.min(prev.low,a.at(-3).low),level:Math.min(prev.low,a.at(-3).low),close:last.close,recovery};
  const swing=pivots(a).filter(i=>i>=n-20).at(-1);
  out.swingHigh=swing===undefined?Math.max(...a.slice(-10).map(b=>b.high)):a[swing].high;
  out.entry=last.close;out.stop=out.swingHigh*1.001;out.stopDistancePct=(out.stop/out.entry-1)*100;
  out.reason=!pumped?'Below 100% pump gate':recovery?'MA recovery veto':!out.confirmation.confirmed?'No bearish 15m close through support':out.score<threshold?'Score below threshold':out.stop<=out.entry?'Swing stop not above entry':out.stopDistancePct>8?'Stop wider than 8%':'Confirmed paper fade';
  out.allowed=out.reason==='Confirmed paper fade';return out;
 }catch(e){return {...out,score:null,reason:e.message};}
}
