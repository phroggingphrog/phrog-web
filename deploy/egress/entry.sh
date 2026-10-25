#!/bin/sh
# SSH dynamic forward to tencentvps (SOCKS 127.0.0.1:1080) fronted by privoxy (HTTP CONNECT :8118).
# ssh is the foreground process, so a dropped tunnel exits the container and systemd restarts it.
set -e
cp /run/secrets/key /tmp/key && chmod 600 /tmp/key
privoxy /etc/egress/privoxy.conf
exec ssh -N -D 127.0.0.1:1080 -i /tmp/key -o UserKnownHostsFile=/etc/egress/known_hosts \
  -o StrictHostKeyChecking=yes -o BatchMode=yes -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 root@150.109.12.201
