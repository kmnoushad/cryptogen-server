#!/usr/bin/env node
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {FadeChartPaper} from '../src/fade-chart-paper.js';
const args=process.argv.slice(2),value=k=>args[args.indexOf(k)+1];
if(!args.includes('--paper')||!args.includes('--data-dir'))throw Error('Use --paper --data-dir /absolute/separate-directory; no real/demo exchange orders are supported');
const directory=resolve(value('--data-dir'));
if(args.includes('--report')){
 const state=JSON.parse(await readFile(join(directory,'state.json'),'utf8'));
 const groups={};for(const t of state.closed)for(const [key,c] of Object.entries(t.score.components)){
  const name=key+':'+String(c.active),g=groups[name]??={trades:0,wins:0,net:0};g.trades++;g.wins+=Number(t.net>0);g.net+=t.net;
 }
 console.log(JSON.stringify({model:state.model,cash:state.cash,open:state.positions.length,closed:state.closed.length,componentGroups:groups,note:'Descriptive simulated outcomes, not causal component benefit; selected trades only. Fees/slippage modeled, funding excluded.'},null,2));
}else if(!args.includes('--locked')){
 // Kernel lock is released even after a crash. No secret-bearing env file.
 await mkdir(directory,{recursive:true,mode:0o700});
 const child=spawn('flock',['-n',join(directory,'.worker.lock'),process.execPath,fileURLToPath(import.meta.url),...args,'--locked'],{stdio:'inherit'});
 for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>child.kill(s));
 child.on('error',e=>{console.error(e.message);process.exitCode=1;});
 child.on('exit',code=>{process.exitCode=code??1;});
}else{
 const threshold=args.includes('--min-score')?Number(value('--min-score')):50;
 if(!Number.isFinite(threshold)||threshold<0||threshold>150)throw Error('--min-score must be 0..150');
 const paper=new FadeChartPaper({directory,threshold});await paper.initialize();let stopping=false;
 for(const s of ['SIGTERM','SIGINT'])process.on(s,()=>{stopping=true;});
 console.log('PHASE 1B chart fade: SIMULATION ONLY; public Binance prices; no account or order API.');
 do{await paper.tick();console.log(JSON.stringify(paper.summary()));if(args.includes('--once')||stopping)break;await new Promise(r=>setTimeout(r,15000));}while(!stopping);
}
