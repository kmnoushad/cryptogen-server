# NEXIO Lead–Lag Research Persistence (paper only)

This change records **sampled quotes** (up to four per second per venue by default) and all emitted signals and paper events as append-only UTC-dated JSONL files. No order APIs are added.

## Before deployment on the isolated AWS checkout
- Ensure the existing live services in /opt/nexio are not modified.
- Create the writable directory: `sudo install -d -o nexio -g nexio -m 700 /opt/nexio-leadlag/data`.
- Pull the reviewed changes into **/opt/nexio-leadlag only**.
- Install the updated systemd unit from `deploy/nexio-leadlag.service`, then run `sudo systemctl daemon-reload`.
- Restart **only** `nexio-leadlag.service`.
- Check `curl -s http://127.0.0.1:8891/health` and ensure `recordErrors` remains zero.
- Inspect `/opt/nexio-leadlag/data/YYYY-MM-DD.jsonl` as user nexio.

## Limitations
- Quote sampling is for initial research, **not** lossless tick-by-tick capture or proof of subsecond price leadership.
- Broker timestamp offset is currently corrected manually in MT5; validate it against UTC and daylight-saving changes.
- Binance bookTicker may omit exchange timestamps, so arrival time is not exchange-event time.
- Files accumulate and need a retention/archival policy; do not publish them or authentication tokens.
- Research data is persisted; in-memory counters, calibration, and paper balance still reset on service restart.
- The SSH tunnel must remain open for MT5 ingestion.
