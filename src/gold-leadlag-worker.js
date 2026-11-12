// Experimental market-data collector only. No exchange order or broker APIs.
import http from 'node:http';
import WebSocket from 'ws';
import { LeadLagPaper } from './gold/leadlag-paper.js';
import { LeadLagRecorder } from './gold/leadlag-recorder.js';

const token=process.env.LEADLAG_INGEST_TOKEN;
if (!token || token.length<32) throw new Error('LEADLAG_INGEST_TOKEN must be at least 32 characters');
const port=Number(process.env.LEADLAG_PORT||8891);
if(!Number.isInteger(port)||port<1024||port>65535) throw new Error('Invalid LEADLAG_PORT');
const account=new LeadLagPaper();
const recorder=new LeadLagRecorder({dir:process.env.LEADLAG_DATA_DIR||'/opt/nexio-leadlag/data'});
let recordErrors=0;
function record(fn){try{fn();}catch(err){recordErrors++;if(recordErrors<=3)console.error('Research recording error:',err.message);}}
const counters={mt5:0,binance:0,rejected:0,signals:0};
let lastMt5=null,lastBinance=null,wsState='disconnected';
let wsOpenedAt=null,wsReconnects=0;
const binanceStaleMs=Number(process.env.LEADLAG_BINANCE_STALE_MS||60000);
if(!Number.isFinite(binanceStaleMs)||binanceStaleMs<15000) throw Error('Invalid LEADLAG_BINANCE_STALE_MS');
account.on('signal',x=>{counters.signals++;record(()=>recorder.event('signal',x));console.log('[leadlag signal]',JSON.stringify(x));});
account.on('open',x=>{record(()=>recorder.event('paper_open',x));console.log('[PAPER ONLY open]',JSON.stringify(x));});
account.on('close',x=>{record(()=>recorder.event('paper_close',x));console.log('[PAPER ONLY close]',JSON.stringify(x));});
const respond=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));};
const server=http.createServer((req,res)=>{
  if(req.method==='GET'&&req.url==='/health')return respond(res,200,{mode:'paper-research',wsState,counters,recordErrors,lastMt5,lastBinance,wsOpenedAt,wsReconnects,binanceStaleMs,summary:account.summary()});
  if(req.method!=='POST'||req.url!=='/tick')return respond(res,404,{error:'not_found'});
  if(req.headers.authorization!==`Bearer ${token}`)return respond(res,401,{error:'unauthorized'});
  let body='';req.on('data',chunk=>{body+=chunk;if(body.length>4096)req.destroy();});
  req.on('end',()=>{
    try{
      const tick=JSON.parse(body);
      const now=Date.now();
      if(tick.venue!=='MT5'||!Number.isFinite(tick.bid)||!Number.isFinite(tick.ask)||!Number.isFinite(tick.exchangeTs))throw Error('invalid_tick');
      const ok=account.ingest({venue:'MT5',bid:tick.bid,ask:tick.ask,exchangeTs:tick.exchangeTs,receivedTs:now});
      if(!ok){counters.rejected++;return respond(res,422,{error:'rejected_tick'});}
      counters.mt5++;lastMt5=now;record(()=>recorder.tick('MT5',{bid:tick.bid,ask:tick.ask,exchangeTs:tick.exchangeTs,receivedTs:now}));respond(res,200,{ok:true});
    }catch{counters.rejected++;respond(res,400,{error:'invalid_json_or_tick'});}
  });
});
server.listen(port,'127.0.0.1',()=>console.log(`Leadlag paper collector on 127.0.0.1:${port}`));
const url='wss://fstream.binance.com/ws/xauusdt@bookTicker';
let activeSocket=null;
let reconnectTimer=null;
function scheduleReconnect(){
  if(reconnectTimer) return;
  reconnectTimer=setTimeout(()=>{reconnectTimer=null;connect();},5000);
  reconnectTimer.unref();
}
function connect(){
  if(activeSocket) return;
  const ws=new WebSocket(url,{handshakeTimeout:10000});
  activeSocket=ws;
  let lastMessageAt=Date.now();
  let openedAt=null;
  const watchdog=setInterval(()=>{
    if(activeSocket!==ws || !openedAt) return;
    if(Date.now()-lastMessageAt>binanceStaleMs){
      wsState='stale';
      wsReconnects++;
      console.error('Binance WS stale: no messages for',Date.now()-lastMessageAt,'ms; reconnecting');
      ws.terminate();
    }
  },Math.min(15000,Math.floor(binanceStaleMs/2)));
  watchdog.unref();
  ws.on('open',()=>{openedAt=Date.now();wsOpenedAt=openedAt;lastMessageAt=openedAt;wsState='connected';console.log('Binance XAUUSDT bookTicker connected');});
  ws.on('message',data=>{
    lastMessageAt=Date.now();
    try{
      const x=JSON.parse(data.toString());
      const bid=Number(x.b),ask=Number(x.a),now=Date.now();
      // bookTicker timestamps may be absent; receipt time is NOT exchange-time proof.
      const exchangeTs=Number(x.E||x.T||now);
      if(account.ingest({venue:'BINANCE',bid,ask,exchangeTs,receivedTs:now})){counters.binance++;lastBinance=now;record(()=>recorder.tick('BINANCE',{bid,ask,exchangeTs,receivedTs:now}));}else counters.rejected++;
    }catch{counters.rejected++;}
  });
  ws.on('error',err=>console.error('Binance WS:',err.message));
  ws.on('close',()=>{
    clearInterval(watchdog);
    if(activeSocket===ws){activeSocket=null;wsState='disconnected';scheduleReconnect();}
  });
}
connect();
