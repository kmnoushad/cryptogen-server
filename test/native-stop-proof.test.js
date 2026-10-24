import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeStopCovers } from '../src/native-stop-proof.js';
import { FadeExchange } from '../src/fade-orders.js';
import { FuturesAutoExchange } from '../src/futures-auto-executor.js';
const action={id:'owned-stop',params:{triggerPrice:'100',quantity:'2'}};
const stop={clientAlgoId:action.id,symbol:'AAA',side:'BUY',algoStatus:'NEW',orderType:'STOP_MARKET',triggerPrice:'100',reduceOnly:true,closePosition:false,quantity:'2',positionSide:'BOTH'};
const context={symbol:'AAA',side:'BUY',quantity:2,price:100,tick:.01,step:.001};
test('replacement proof covers full current exposure and remains protective after partial TP fills',()=>{
 assert.equal(nativeStopCovers(stop,action,context),true);assert.equal(nativeStopCovers(stop,action,{...context,quantity:.5}),true);
 assert.equal(nativeStopCovers(stop,action,{...context,quantity:2.001}),false);
});
test('wrong direction, missing reduce-only, quantity, identity or terminal status is never protection',()=>{
 for(const patch of [{side:'SELL'},{reduceOnly:false},{closePosition:true},{quantity:'1.999'},{quantity:'NaN'},{clientAlgoId:'manual'},{symbol:'OTHER'},{algoStatus:'FILLED'},{orderType:'LIMIT'},{positionSide:'LONG'},{triggerPrice:'99'},{workingType:'MARK_PRICE'}])
  assert.equal(nativeStopCovers({...stop,...patch},action,context),false,JSON.stringify(patch));
});
test('legacy close-position stops remain supported, but cannot masquerade as quantity stops',()=>{
 const legacy={...stop,closePosition:true,reduceOnly:false};delete legacy.quantity;
 assert.equal(nativeStopCovers(legacy,{...action,params:{triggerPrice:100}},context),true);
 assert.equal(nativeStopCovers(legacy,action,context),false);
});
test('real REST adapters keep initial close-all and omit closePosition entirely on quantity replacements',async()=>{
 for(const [Class,side] of [[FadeExchange,'BUY'],[FuturesAutoExchange,'SELL']]){
  const exchange=Object.create(Class.prototype);const calls=[];exchange.request=async(...args)=>calls.push(args);
  const place=Class===FadeExchange?(quantity)=>exchange.placeStop('AAA','id',100,quantity):(quantity)=>exchange.placeDirectionalStop('AAA','id',100,side,quantity);
  await place();await place(2);const initial=calls[0][2],replacement=calls[1][2];
  assert.equal(initial.closePosition,'true');assert.equal(initial.quantity,undefined);
  assert.equal(replacement.closePosition,undefined);assert.equal(replacement.reduceOnly,'true');assert.equal(replacement.quantity,'2');assert.equal(replacement.side,side);
 }
});
import { cancelWithAbsenceProof } from '../src/native-stop-proof.js';
test('cancel races require terminal status or explicit absence, never swallow live orders or read outages',async()=>{
 const error=Object.assign(Error('cancel failed'),{code:-2011});const cancel=async()=>{throw error;};
 await cancelWithAbsenceProof(cancel,async()=>({status:'FILLED'}));
 await cancelWithAbsenceProof(cancel,async()=>{throw Object.assign(Error('absent'),{code:-2013});});
 await assert.rejects(cancelWithAbsenceProof(cancel,async()=>({status:'NEW'})),/cancel failed/);
 await assert.rejects(cancelWithAbsenceProof(cancel,async()=>{throw Error('offline');}),/offline/);
 await assert.rejects(cancelWithAbsenceProof(async()=>{throw Object.assign(Error('denied'),{code:-2015});},async()=>({status:'FILLED'})),/denied/);
});
