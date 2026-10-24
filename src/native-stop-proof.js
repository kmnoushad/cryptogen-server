const truth = value => value === true || value === 'true';
// Bind protection proof to the journaled ID, parameters and owned exposure.
// A reduce-only quantity may exceed a shrunken remaining position; it cannot
// reverse it. An undersized stop never counts as full protection.
export function nativeStopCovers(stop, action, { symbol, side, quantity, price, tick, step }) {
  if (!stop || !action || stop.clientAlgoId !== action.id || stop.symbol !== symbol || stop.side !== side ||
      stop.algoStatus !== 'NEW' || (stop.orderType ?? stop.type) !== 'STOP_MARKET' ||
      (stop.positionSide && stop.positionSide !== 'BOTH') ||
      (stop.workingType && stop.workingType !== 'CONTRACT_PRICE') ||
      !(Number(stop.triggerPrice) > 0) || !Number.isFinite(Number(stop.triggerPrice)) ||
      Math.abs(Number(stop.triggerPrice)-Number(price)) > tick/2) return false;
  if (action.params.quantity == null) return truth(stop.closePosition);
  const intended=Number(action.params.quantity), actual=Number(stop.quantity ?? stop.origQty);
  return truth(stop.reduceOnly) && !truth(stop.closePosition) && Number.isFinite(intended) && intended>0 &&
    Number.isFinite(actual) && actual>0 && Math.abs(actual-intended)<=step/2 &&
    Number.isFinite(quantity) && quantity>0 && actual+1e-8>=quantity;
}

export async function cancelWithAbsenceProof(cancel, lookup) {
  try { return await cancel(); }
  catch (error) {
    if (![-2011,-2013].includes(error.code)) throw error;
    try {
      const order = await lookup();
      if (['FILLED','FINISHED','CANCELED','EXPIRED','EXPIRED_IN_MATCH','REJECTED'].includes(order?.algoStatus ?? order?.status)) return;
    } catch (readError) { if (readError.code === -2013) return; throw readError; }
    throw error; // Still live, or unverifiable: do not claim cancellation.
  }
}
