export const clock=Date.parse('2026-10-24T12:00:03Z');
export function momentumFixture(now=clock){
 const end=Math.floor(now/60000)*60000;
 const m1=Array.from({length:499},(_,i)=>{const c=100+Math.max(0,i-469)*.01+(i===498?.15:0),q=i>=494?20000:10000,t=end-(499-i)*60000;return[t,c-.03,c+.1,c-.1,c,100,t+59999,q,0,0,q*.65];});
 const e15=Math.floor(now/900000)*900000;
 const m15=Array.from({length:121},(_,i)=>{const t=e15-(121-i)*900000;return[t,100,100.3,99.7,100.05,100,t+899999,10000,0,0,6000];});
 return {symbol:'ETHUSDT',m1,m15,now};
}
