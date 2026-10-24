// Root loads environment files, then drops privileges. Read-only checks share
// the workers' budget and cannot hammer an IP still in exchange cooldown.
import fs from 'node:fs';
const mode=process.argv[2];
if(!['fade','futures'].includes(mode))throw Error('Choose fade or futures');
const directory=process.env.NEXIO_BINANCE_BUDGET_DIR;
if(!directory)throw Error('Shared Binance budget directory is required');
if(process.getuid?.()===0) {
 const owner=fs.statSync(directory);
 process.setgroups([]);process.setgid(owner.gid);process.setuid(owner.uid);
}
await import(mode==='fade' ? './fade-preflight.js' : './futures-auto-preflight.js');
