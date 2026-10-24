export function fixture(direction='LONG', now=3600001) {
  const rows=Array.from({length:60},(_,i)=>({time:now-1-(60-i)*60000,end:now-2-(59-i)*60000,open:100,high:100.1,low:99.9,close:100,volume:100,quote:10000,buy:6000}));
  Object.assign(rows[56],{open:100,high:100.15,low:99.8,close:100.05});
  Object.assign(rows[57],{open:100.05,high:100.5,low:100.03,close:100.45,volume:200,buy:7000});
  Object.assign(rows[58],{open:100.4,high:100.5,low:100.3,close:100.4});
  Object.assign(rows[59],{open:100.18,high:100.28,low:100.16,close:100.22});
  return direction==='LONG'?rows:rows.map(b=>({...b,open:200-b.open,close:200-b.close,high:200-b.low,low:200-b.high,buy:b.quote-b.buy}));
}
