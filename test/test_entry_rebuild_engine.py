import importlib.util, unittest
from pathlib import Path
spec = importlib.util.spec_from_file_location('engine', Path(__file__).parents[1] / 'scripts/entry-rebuild-engine.py')
e = importlib.util.module_from_spec(spec); spec.loader.exec_module(e)
class Accounting(unittest.TestCase):
    def position(self, sign):
        risk, target, be, trigger = e.exit_prices(sign, 100, 100-sign, 1, 1.5)
        return risk, dict(sign=sign, fill=100, stop=100-sign, target=target, be=be,
          be_trigger=trigger, qty=1, moved=False, hold=240, entry=0)
    def test_stop_precedes_target_in_ambiguous_bar(self):
        for sign in [-1, 1]:
            risk, tr = self.position(sign)
            pnl, reason = e.manage(tr, [0,100,105,95,100], 60000)
            self.assertEqual(reason, 'STOP'); self.assertAlmostEqual(pnl/risk, -1)
    def test_net_target_exact_both_directions(self):
        for sign in [-1, 1]:
            risk, tr = self.position(sign)
            self.assertAlmostEqual(e.cash_pnl(tr, tr['target'])/risk, 1.5)
    def test_break_even_changes_only_next_bar(self):
        for sign in [-1, 1]:
            risk, tr = self.position(sign)
            hi = tr['be_trigger']+.01 if sign == 1 else 100.1
            lo = 99.9 if sign == 1 else tr['be_trigger']-.01
            self.assertIsNone(e.manage(tr, [0,100,hi,lo,100], 60000))
            self.assertTrue(tr['moved'])
            self.assertAlmostEqual(e.cash_pnl(tr, tr['stop']), 0)
if __name__ == '__main__': unittest.main()
