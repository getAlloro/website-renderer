#!/usr/bin/env bash
set -u
DIR=/opt/alloro/edge-block
OUT=/etc/caddy/snippets/edge-block.caddy
pat='^[0-9a-fA-F:.]+/[0-9]+$'
DC=$(grep -E "$pat" "$DIR/datacenter-cidrs.txt" | tr '\n' ' ' | sed 's/ *$//')
AL=$(grep -E "$pat" "$DIR/allowed-cidrs.txt"   | tr '\n' ' ' | sed 's/ *$//')
ndc=$(grep -cE "$pat" "$DIR/datacenter-cidrs.txt")
nal=$(grep -cE "$pat" "$DIR/allowed-cidrs.txt")
tmp=$(mktemp)
{
  printf '# generated %s by gen-caddy-snippet.sh -- DO NOT hand-edit.\n' "$(date -u +%FT%TZ)"
  printf '# datacenter=%s allowlist=%s  source: %s/{datacenter,allowed}-cidrs.txt\n' "$ndc" "$nal" "$DIR"
  printf '(edge_block) {\n'
  printf '    route {\n'
  printf '        @edge_blocked {\n'
  printf '            remote_ip %s\n' "$DC"
  printf '            not remote_ip %s\n' "$AL"
  printf '            not path /.well-known/acme-challenge/*\n'
  printf '        }\n'
  printf '        respond @edge_blocked 403\n'
  printf '        reverse_proxy localhost:7777\n'
  printf '    }\n'
  printf '}\n'
} > "$tmp"
bytes=$(wc -c < "$tmp")
sudo cp "$tmp" "$OUT"; sudo chmod 644 "$OUT"; rm -f "$tmp"
echo "wrote $OUT: ${bytes} bytes | datacenter=${ndc} allowed=${nal}"
