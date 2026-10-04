import test from 'node:test';
import assert from 'node:assert/strict';
import { efficiency, regimeEntry } from '../src/regime-entry-models.js';
const now = 1800000000000;
function flat(interval) {
  const end = Math.floor(now / interval) * interval;
  return Array.from({ length: 90 }, (_, i) => {
    const t = end - (90-i)*interval;
    return [t, 100, 102, 98, 100, 100, t+interval-1, 10000, 0, 0, 6000];
  });
}
function rangeInput() {
  const m5=flat(300000), m1=flat(60000), btc1=flat(60000);
  m5[89].splice(1,4,97.99,98.3,97.95,98.1);m5[89][7]=9810;m5[89][10]=6000;
  return { model:'rangeReversion5',symbol:'ETHUSDT',m1,m5,btc1,now };
}
test('range edge rejection has sufficient reward and remains impossible to route as an allowed order', () => {
  const x=regimeEntry(rangeInput());
  assert.equal(x.candidate,true,x.reason);assert.equal(x.direction,'LONG');
  assert.equal(x.allowed,false);assert.equal(x.executable,false);assert.equal(x.centre,100);
  const input=rangeInput(), future=[...input.m5.at(-1)];future[0]+=300000;future[6]+=300000;
  future[2]=150;future[4]=150;
  assert.deepEqual(regimeEntry({...input,m5:[...input.m5,future]}),x);
});
test('range model mirrors short and rejects a market with persistent movement', () => {
  const input=rangeInput(),mirror=xs=>xs.map(r=>{
    const x=[...r];x[1]=200-r[1];x[2]=200-r[3];x[3]=200-r[2];x[4]=200-r[4];
    x[7]=x[4]*x[5];x[10]=x[7]*(1-r[10]/r[7]);return x;
  });
  const x=regimeEntry({...input,m5:mirror(input.m5)});
  assert.equal(x.candidate,true,x.reason);assert.equal(x.direction,'SHORT');
  const btc1=input.btc1.map((r,i)=>{
    const x=[...r],p=100+i*.02;x.splice(1,4,p,p+.1,p-.1,p);return x;
  });
  assert.match(regimeEntry({...input,btc1}).reason,/not ranging/);
  assert.equal(efficiency([1,2,3,4]),1);assert.equal(efficiency([1,2,1,2,1]),0);
});
test('failed reclaim requires distinct rejection/retest/confirmation and permits only a research candidate', () => {
  const m1=flat(60000),m5=flat(300000),btc1=flat(60000);
  for(let i=0;i<87;i++){const p=100+i*.08;m1[i].splice(1,4,p,p+.1,p-.1,p);}
  m1[87].splice(1,4,106.96,107.1,106.9,106.95);
  m1[88].splice(1,4,106.96,107.05,106.9,106.94);
  m1[89].splice(1,4,106.93,106.94,106.85,106.88);m1[89][10]=4000;
  const input={model:'failedReclaimFade1',symbol:'ETHUSDT',m1,m5,btc1,now,gain24h:20,quote24h:20000000};
  const x=regimeEntry(input);assert.equal(x.candidate,true,x.reason);assert.equal(x.allowed,false);
  const successful=m1.map(r=>[...r]);successful[88][4]=107.08;successful[88][2]=107.09;
  assert.match(regimeEntry({...input,m1:successful}).reason,/failed reclaim/);
  assert.match(regimeEntry({...input,gain24h:0}).reason,/pump/);
});
