import {readFile,stat} from 'node:fs/promises';
export async function fadeChartStatus(path){
 if(!path)return 'PHASE 1B FADE — SIMULATION\nNot configured. Set FADE_CHART_PAPER_STATUS_FILE to the separate paper state.json. No Binance orders.';
 try{
  if((await stat(path)).size>10_000_000)throw Error('Paper state too large for Telegram; use CLI report');
  const s=JSON.parse(await readFile(path,'utf8'));
  if(s.model!=='fade-chart-paper-v1'||!Number.isFinite(s.cash)||!Array.isArray(s.positions)||!Array.isArray(s.closed))throw Error('Invalid simulation state');
  return `PHASE 1B FADE — SIMULATION ONLY\nVirtual cash $${s.cash.toFixed(2)} · ${s.positions.length} open · ${s.closed.length} closed\nLast scan: ${s.lastScanAt?new Date(s.lastScanAt).toISOString():'not completed'}\n${s.lastError?'Error: '+s.lastError:'No recorded scan error'}\nMonitoring: ${s.monitoringStatus??'not checked'}\n15m chart score · ≥100% pump · bearish close required\nNo Binance orders. Fees/slippage modeled; funding excluded.`;
 }catch(e){return 'PHASE 1B FADE — SIMULATION\nStatus unavailable: '+e.message;}
}
