"""Fixed causal replay accounting; independent unit risk, not exchange fills."""
import numpy as np
MIN = 60000
FEE, EXIT_SLIP = .0005, .0005
FILTERS = {'BTCUSDT': (.001, 100, .1), 'ETHUSDT': (.001, 20, .01), 'SOLUSDT': (.01, 5, .01)}

def summaries(trades, begin, end):
    cuts = (begin+.4*(end-begin), begin+.7*(end-begin))
    groups = {'all':trades,
      'development':[t for t in trades if t['exit']<cuts[0]],
      'validation':[t for t in trades if t['entry']>=cuts[0] and t['exit']<cuts[1]],
      'reused_confirmation':[t for t in trades if t['entry']>=cuts[1]]}
    out = {}
    for name, ts in groups.items():
        rs=np.array([t['r'] for t in ts]); pnl=np.array([t['pnl'] for t in ts])
        gains=pnl[pnl>0].sum(); losses=-pnl[pnl<0].sum()
        path=np.r_[0,np.cumsum(pnl)]
        out[name]={'n':len(ts),'win_pct':float(100*np.mean(pnl>0)) if len(ts) else None,
          'expectancy_r':float(rs.mean()) if len(ts) else None,
          'pf':float(gains/losses) if losses else None,
          'net':float(pnl.sum()),'max_closed_dd':float(np.max(np.maximum.accumulate(path)-path))}
    return out

def exit_prices(sign, fill, stop, qty, target_r, tick=0):
    loss=qty*(fill*(1+FEE)-stop*(1-FEE-EXIT_SLIP)) if sign==1 else qty*(stop*(1+FEE+EXIT_SLIP)-fill*(1-FEE))
    target=(target_r*loss/qty+fill*(1+FEE))/(1-FEE-EXIT_SLIP) if sign==1 else (fill*(1-FEE)-target_r*loss/qty)/(1+FEE+EXIT_SLIP)
    be=fill*(1+FEE)/(1-FEE-EXIT_SLIP) if sign==1 else fill*(1-FEE)/(1+FEE+EXIT_SLIP)
    be_trigger=(loss/qty+fill*(1+FEE))/(1-FEE-EXIT_SLIP) if sign==1 else (fill*(1-FEE)-loss/qty)/(1+FEE+EXIT_SLIP)
    if tick:
        rounding=np.ceil if sign==1 else np.floor
        target=float(rounding(target/tick)*tick); be=float(rounding(be/tick)*tick)
    return loss,target,be,be_trigger

def cash_pnl(tr, px, market=True):
    slip=EXIT_SLIP if market else 0
    return tr['qty']*(px*(1-FEE-slip)-tr['fill']*(1+FEE)) if tr['sign']==1 else tr['qty']*(tr['fill']*(1-FEE)-px*(1+FEE+slip))

def manage(tr, row, now):
    op, hi, lo, cl=row[1:5]; sign=tr['sign']
    # Unknown intrabar ordering: stop first. BE changes apply next minute.
    if (lo<=tr['stop'] if sign==1 else hi>=tr['stop']):
        return cash_pnl(tr,min(op,tr['stop']) if sign==1 else max(op,tr['stop'])),'BE' if tr['moved'] else 'STOP'
    if (hi>=tr['target'] if sign==1 else lo<=tr['target']): return cash_pnl(tr,tr['target'],False),'TARGET'
    if not tr['moved'] and (hi>=tr['be_trigger'] if sign==1 else lo<=tr['be_trigger']):
        tr['stop']=tr['be']; tr['moved']=True
    if now-tr['entry']>=tr['hold']*MIN: return cash_pnl(tr,cl),'TIME'
    return None

