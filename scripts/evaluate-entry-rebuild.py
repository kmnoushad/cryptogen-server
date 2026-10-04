"""Offline fixed hypotheses. No credentials or order API. Reused history only."""
import argparse, importlib.util, json
from pathlib import Path
import numpy as np

def load_engine(path):
    spec = importlib.util.spec_from_file_location('engine', path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module

def run(root, events, model, slip, delay, engine):
    cache, busy, trades, counts = {}, {}, [], {}
    def skip(reason): counts[reason] = counts.get(reason, 0) + 1
    for ev in sorted((e for e in events if e['model'] == model), key=lambda e: (e['time'], e['symbol'])):
        symbol = ev['symbol']; sign = 1 if ev['direction'] == 'LONG' else -1
        if symbol not in cache: cache[symbol] = np.memmap(root / (symbol + '_1m.f64'), dtype='<f8', mode='r').reshape(-1, 8)
        rows = cache[symbol]; k = ev['barIndex'] + 1 + delay
        if k + 240 > len(rows): skip('incomplete_exit_window'); continue
        t = int(rows[k, 0]); ref = ev['entry']; stop = ev['stop']
        if t < busy.get(symbol, 0): skip('same_symbol_overlap'); continue
        fill = float(rows[k, 1]) * (1 + sign * slip)
        distance = sign * (fill - stop)
        if distance <= 0: skip('invalidation'); continue
        costs = fill * engine.FEE + stop * (engine.FEE + engine.EXIT_SLIP)
        if costs / (distance + costs) > .25: skip('cost_ceiling'); continue
        if sign * (fill - ref) > min(ref * .0015, distance * .25): skip('no_chase'); continue
        risk, target, be, be1 = engine.exit_prices(sign, fill, stop, 1, 1.5)
        tr = dict(entry=t, sign=sign, qty=1., fill=fill, stop=stop, target=target,
                  be=be, be_trigger=be1, moved=False, hold=240)
        for j in range(k, k + 240):
            result = engine.manage(tr, rows[j], int(rows[j, 0] + 60000))
            if result:
                pnl, reason = result; end = int(rows[j, 0] + 60000)
                trades.append(dict(symbol=symbol, entry=t, exit=end, r=float(pnl / risk),
                                   pnl=float(pnl / risk), reason=reason, direction=ev['direction']))
                busy[symbol] = end; break
    return trades, counts

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--data', required=True); ap.add_argument('--signals', required=True)
    ap.add_argument('--engine', default=str(Path(__file__).with_name('entry-rebuild-engine.py'))); ap.add_argument('--models', default='pullback5,compression5,auctionFade5'); ap.add_argument('--out', required=True); args = ap.parse_args()
    root = Path(args.data); manifest = json.loads((root / 'manifest.json').read_text())
    events = json.loads(Path(args.signals).read_text()); engine = load_engine(args.engine)
    result = {'liveOrders': False, 'acceptance': 'Research only. No live approval; fresh holdout and portfolio/fill validation required.',
      'limitations': ['Previously examined 14-day history is reused confirmation, not untouched holdout.',
        'Current-listing survivor sample; sampled universe top20. PORTAL file incomplete and excluded.',
        'Independent risk units; no simultaneous-position margin limits or live risk brakes.',
        'No historical funding, OI, event, spread or order-book replay.',
        'Fees 0.05%/side; stop/time exit slippage 0.05%; target touch assumed; stop wins intrabar ties.',
        'Break-even moves apply next bar. Funding not modeled. Net is summed risk units, not USD.',
        'Slippage/delay runs reapply entry checks and have different accepted cohorts; positive subset results do not prove fill robustness.'], 'models': {}}
    for model in args.models.split(','):
        for scenario, slip, delay in [('base', .0005, 0), ('slippage', .0015, 0), ('delay', .0005, 1)]:
            trades, counts = run(root, events, model, slip, delay, engine)
            summary = engine.summaries(trades, manifest['evaluationStart'], manifest['end'])
            name = model + '_' + scenario
            result['models'][name] = dict(summary=summary, skipped=counts, trades=trades)
            print(name, json.dumps(summary['all']), flush=True)
    Path(args.out).write_text(json.dumps(result, indent=2, allow_nan=False))
if __name__ == '__main__': main()
