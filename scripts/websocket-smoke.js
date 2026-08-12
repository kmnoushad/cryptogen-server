import WebSocket from 'ws';

const url = 'wss://fstream.binance.com/market/ws/btcusdt@aggTrade';
const socket = new WebSocket(url);

const timer = setTimeout(() => {
  socket.terminate();
  console.error('BTC Futures WebSocket did not deliver a trade within 15 seconds');
  process.exitCode = 1;
}, 15_000);

socket.once('message', raw => {
  try {
    const event = JSON.parse(String(raw));
    const price = Number(event.p);
    if (!(price > 0)) throw new Error('invalid BTC trade price');
    console.log(JSON.stringify({ ok: true, stream: 'btcusdt@aggTrade', price, eventTime: event.E }, null, 2));
    clearTimeout(timer);
    socket.close();
  } catch (error) {
    clearTimeout(timer);
    socket.terminate();
    console.error(`BTC Futures WebSocket payload failed validation: ${error.message}`);
    process.exitCode = 1;
  }
});

socket.once('error', error => {
  clearTimeout(timer);
  console.error(`BTC Futures WebSocket connection failed: ${error.message}`);
  process.exitCode = 1;
});
