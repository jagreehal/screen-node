#!/bin/sh
# sandbox-node metadata guard.
#
# Only used in "on"/open network mode, where the container sits on the default
# bridge and therefore has a route to the host's link-local cloud-metadata service
# (169.254.169.254 and friends). A malicious install/dev dependency could hit it to
# steal instance / role credentials — the classic supply-chain -> cloud pivot.
#
# We're started with just CAP_NET_ADMIN + CAP_SETPCAP. Blackhole the metadata
# endpoints, then DROP EVERY capability and exec the real command — so the command
# can neither reach IMDS nor undo the block.
for ip in 169.254.169.254 169.254.170.2 100.100.100.200; do
  ip route add blackhole "$ip/32" 2>/dev/null || true
done
ip -6 route add blackhole fd00:ec2::254/128 2>/dev/null || true

exec capsh --drop=cap_net_admin,cap_setpcap -- -c 'exec "$@"' sandbox "$@"
