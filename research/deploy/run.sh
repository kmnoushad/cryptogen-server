#!/bin/sh
# Run one ghr command as a transient, resource-capped systemd unit.
#   sudo ./deploy/run.sh universe
#   sudo ./deploy/run.sh download --months 2026-04
#   sudo ./deploy/run.sh report --months 2025-10:2026-09
# Follow:  journalctl -u nexio-research -f
# Stop:    sudo systemctl stop nexio-research   (safe; rerun resumes)
set -eu
exec systemd-run --unit=nexio-research --collect --no-block \
  --uid=nexio-research --gid=nexio-research \
  -p MemoryMax=600M -p MemorySwapMax=0 \
  -p CPUQuota=50% -p CPUWeight=10 -p Nice=19 -p IOSchedulingClass=idle -p TasksMax=32 \
  -p NoNewPrivileges=true -p PrivateTmp=true -p ProtectSystem=strict -p ProtectHome=true \
  -p ReadWritePaths=/srv/nexio-research/golden-hour \
  -p "InaccessiblePaths=-/opt/nexio -/etc/nexio-fade.env -/etc/nexio-futures.env -/etc/nexio-gold.env" \
  -p UMask=0027 \
  -p WorkingDirectory=/srv/nexio-research/code/research/golden-hour \
  -E GHR_ROOT=/srv/nexio-research/golden-hour \
  /srv/nexio-research/venv/bin/python -m ghr.cli "$@"
