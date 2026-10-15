#!/bin/sh
# One-time setup. Touches nothing under /opt/nexio and restarts no service.
set -eu
REPO=https://github.com/kmnoushad/cryptogen-server.git
BRANCH=${1:-research/golden-hour-phase2}

id nexio-research >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /usr/sbin/nologin nexio-research
sudo mkdir -p /srv/nexio-research/golden-hour
sudo chown nexio-research:nexio-research /srv/nexio-research/golden-hour
sudo chmod 750 /srv/nexio-research/golden-hour

if [ ! -d /srv/nexio-research/code ]; then
  sudo git clone --depth 1 --branch "$BRANCH" "$REPO" /srv/nexio-research/code
else
  sudo git -C /srv/nexio-research/code fetch --depth 1 origin "$BRANCH"
  sudo git -C /srv/nexio-research/code checkout --detach FETCH_HEAD
fi

command -v python3 >/dev/null || { echo "python3 missing"; exit 1; }
python3 -c 'import venv' 2>/dev/null || sudo apt-get install -y python3-venv
[ -d /srv/nexio-research/venv ] || sudo python3 -m venv /srv/nexio-research/venv
sudo /srv/nexio-research/venv/bin/pip install -q -r /srv/nexio-research/code/research/golden-hour/requirements.txt
sudo chmod +x /srv/nexio-research/code/research/golden-hour/deploy/run.sh
echo "Installed. Next: cd /srv/nexio-research/code/research/golden-hour && sudo ./deploy/run.sh universe"
