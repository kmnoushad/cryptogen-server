// Isolated market data collector for lead-lag research. Never sends orders.
import dns from 'node:dns';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import WebSocket from 'ws';
import { LeadLagPaper } from './gold/leadlag-paper.js';

dns.setDefaultResultOrder('ipv4first');
const symbol=(process.env.LEADLAG_BINANCE_SYMBOL||'XAUUSDT').toUpperCase();
if(!/^[A-Z0-9]{3,24}$/.test(symbol)) throw Error('Invalid symbol');
const token=process.env.LEADLAG_INGEST_TOKEN||'';
if(token.length<32) throw Error('LEADLAG_INGEST_TOKEN must be >=32 characters');
const port=Number(process.env.LEADLAG_PORT||8891);
const paper=new LeadLagPaper();
const status={binance:'connecting',mt5:'waiting',lastBinance:0,lastMt5:0,errors:0};
const equal=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&timingSafeEqual(x,y);};
let ws, retry=1000, stopping=false;
function connect() {
  if(stopping)return;
  // Binance USD-M futures executable top-of-book, not mark/index price.
  ws=new WebSocket(`wss://fstream.binance.com/ws/${symbol.toLowerCase()}@bookTicker`,{handshakeTimeout:10000});
  ws.on('open',()=>{retry=1000;status.binance='connected';console.log('Binance bookTicker connected',symbol);});
  ws.on('message',raw=>{
    try {
      const m=JSON.parse(raw.toString());
      if(m.e==='error'||m.code)throw Error(m.msg||'Binance stream error');
      const bid=Number(m.b),ask=Number(m.a);
      // bookTicker may lack exchange event time; use receipt time and flag it as such.
      const receivedTs=Date.now();
      const exchangeTs=Number.isFinite(Number(m.E))&&Number(m.E)>0?Number(m.E):receivedTs;
      if(paper.ingest({venue:'BINANCE',bid,ask,exchangeTs,receivedTs}))status.lastBinance=receivedTs;
    }catch(e){status.errors++;console.error('Binance message:',e.message);}
  });
  ws.on('error',e=>{status.errors++;console.error('Binance WS:',e.message);});
  ws.on('close',()=>{status.binance='disconnected';if(!stopping){setTimeout(connect,retry);retry=Math.min(retry*2,30000);}});
}
const server=http.createServer(async(req,res)=>{
  const send=(code,data)=>{res.writeHead(code,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));};
  if(req.url==='/health'&&req.method==='GET')return send(200,{status,summary:paper.summary(),symbol,liveOrders:false});
  if(req.url!=='/mt5/tick'||req.method!=='POST')return send(404,{error:'not_found'});
  const auth=req.headers.authorization||'';
  if(!auth.startsWith('Bearer ')||!equal(auth.slice(7),token))return send(401,{error:'unauthorized'});
  let raw='';
  try {
    for await(const chunk of req){raw+=chunk;if(raw.length>2048)throw Error('payload too large');}
    const data=JSON.parse(raw);
    const bid=Number(data.bid),ask=Number(data.ask),exchangeTs=Number(data.exchangeTs);
    // Require genuine millisecond epoch timestamps from the terminal bridge.
    if(!Number.isSafeInteger(exchangeTs)||Math.abs(Date.now()-exchangeTs)>10000) return send(422,{error:'stale_or_invalid_timestamp'});
    const accepted=paper.ingest({venue:'MT5',bid,ask,exchangeTs,receivedTs:Date.now()});
    if(accepted)status.lastMt5=Date.now();
    status.mt5=accepted?'connected':'invalid';
    return send(accepted?200:422,{accepted});
  }catch(e){status.errors++;return send(400,{error:'bad_request'});}
});
paper.on('signal',s=>console.log('LEADLAG SIGNAL (RESEARCH ONLY)',JSON.stringify(s)));
paper.on('open',t=>console.log('PAPER OPEN',JSON.stringify(t)));
paper.on('close',t=>console.log('PAPER CLOSE',JSON.stringify(t)));
server.listen(port,'127.0.0.1',()=>{console.log('Leadlag collector localhost:',port);connect();});
const shutdown=()=>{stopping=true;ws?.close();server.close();};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
