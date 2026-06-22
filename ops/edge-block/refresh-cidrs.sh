#!/usr/bin/env bash
# Generates datacenter-cidrs.txt (blocklist) + allowed-cidrs.txt (allowlist).
# Each source is best-effort: a failed fetch logs and is skipped, never aborts.
set -uo pipefail
OUT=/opt/alloro/edge-block
TMP=$(mktemp -d)
DC="$TMP/dc.txt"; AL="$TMP/al.txt"; : > "$DC"; : > "$AL"
fetch() { curl -fsS --max-time 30 "$1"; }

# ---- BLOCKLIST: cloud / hosting ranges ----
fetch https://ip-ranges.amazonaws.com/ip-ranges.json | python3 -c 'import sys,json
d=json.load(sys.stdin)
for p in d.get("prefixes",[]): print(p["ip_prefix"])
for p in d.get("ipv6_prefixes",[]): print(p["ipv6_prefix"])' >> "$DC" && echo "  aws: ok" || echo "  aws: FAILED"

fetch https://www.gstatic.com/ipranges/cloud.json | python3 -c 'import sys,json
d=json.load(sys.stdin)
for p in d.get("prefixes",[]):
 print(p.get("ipv4Prefix") or p.get("ipv6Prefix"))' >> "$DC" && echo "  gcp: ok" || echo "  gcp: FAILED"

fetch https://www.digitalocean.com/geo/google.csv | cut -d, -f1 | grep -E '/[0-9]+$' >> "$DC" && echo "  digitalocean: ok" || echo "  digitalocean: FAILED"

fetch https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json | python3 -c 'import sys,json
d=json.load(sys.stdin)
for r in d.get("regions",[]):
 for c in r.get("cidrs",[]): print(c["cidr"])' >> "$DC" && echo "  oracle: ok" || echo "  oracle: FAILED"

# ---- ALLOWLIST: our infra + verified crawlers ----
for ip in 18.213.168.139 23.20.182.194 23.23.202.251 3.210.251.123 3.210.41.226 44.220.215.37 52.203.199.155 54.159.199.33 54.197.53.133; do echo "$ip/32"; done >> "$AL"

fetch https://developers.google.com/static/search/apis/ipranges/googlebot.json | python3 -c 'import sys,json
d=json.load(sys.stdin)
for p in d.get("prefixes",[]): print(p.get("ipv4Prefix") or p.get("ipv6Prefix"))' >> "$AL" && echo "  googlebot: ok" || echo "  googlebot: FAILED"

fetch https://www.bing.com/toolbox/bingbot.json | python3 -c 'import sys,json
d=json.load(sys.stdin)
for p in d.get("prefixes",[]): print(p.get("ipv4Prefix") or p.get("ipv6Prefix"))' >> "$AL" && echo "  bing: ok" || echo "  bing: FAILED"

grep -hEv '^$' "$DC" | sort -u > "$OUT/datacenter-cidrs.txt"
grep -hEv '^$' "$AL" | sort -u > "$OUT/allowed-cidrs.txt"
chmod 644 "$OUT"/*.txt
echo "datacenter CIDRs: $(wc -l < "$OUT/datacenter-cidrs.txt")"
echo "allowed CIDRs:    $(wc -l < "$OUT/allowed-cidrs.txt")"
rm -rf "$TMP"
