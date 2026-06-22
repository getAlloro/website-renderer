#!/usr/bin/env bash
set -uo pipefail
DIR=/opt/alloro/edge-block
[ -f "$DIR/.env" ] && { set -a; . "$DIR/.env"; set +a; }
gather() {
  local lf
  while IFS= read -r lf; do
    case "$lf" in
      *.gz) sudo zcat -- "$lf" 2>/dev/null ;;
      *)    sudo cat  -- "$lf" 2>/dev/null ;;
    esac
  done < <(sudo find /var/log/caddy -maxdepth 1 -name 'access*.log*' -mtime -2 2>/dev/null | sort)
}
OUT=$(gather | python3 "$DIR/analyze-dryrun.py")
VERDICT=$(printf '%s' "$OUT" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["verdict"])
except Exception: print("ERROR")' 2>/dev/null)
TEXT=$(printf '%s' "$OUT" | python3 -c 'import sys,json
try: print(json.load(sys.stdin)["text"])
except Exception: print("analyzer produced no valid output")' 2>/dev/null)
STATE="$DIR/clean-streak.txt"; TODAY=$(date -u +%Y-%m-%d); LAST_DATE=""; STREAK=0
[ -f "$STATE" ] && read -r LAST_DATE STREAK < "$STATE" 2>/dev/null || true
[ -z "${STREAK:-}" ] && STREAK=0
if [ "$TODAY" != "$LAST_DATE" ]; then
  if [ "$VERDICT" = "CLEAN" ]; then STREAK=$((STREAK+1)); else STREAK=0; fi
  echo "$TODAY $STREAK" > "$STATE"
fi
PLANREF="EXECUTE WHEN READY (in the alloro repo, ~/Desktop/alloro):
  -> plans/06172026-renderer-edge-bot-block/RUNBOOK.md   (section 8 = step-by-step T5 enforce)
  -> plans/06172026-renderer-edge-bot-block/spec.html    (the spec)"
REMINDER="ROLLOUT STATUS: ENFORCED -- datacenter/cloud ranges are BLOCKED at the renderer edge (live 2026-06-22).
Post-enforce WATCHDOG: verified Googlebot/Bing in the blocked set below MUST stay 0.
If a verified crawler appears it is being wrongly 403d -> add its range via refresh-cidrs.sh then restart caddy.
Days clean since tracking: ${STREAK}.
Rollback: restore /home/ubuntu/caddy-backups/Caddyfile.*.bak then run: sudo systemctl restart caddy
  -> plans/06172026-renderer-edge-bot-block/RUNBOOK.md (section 9 = post-enforce monitoring)"
BODY="${REMINDER}

========================================
${TEXT}"
echo "$BODY"
{ echo "===== $(date -u +%Y-%m-%dT%H:%M:%SZ) (streak=${STREAK}) ====="; echo "$BODY"; echo; } >> "$DIR/dryrun-history.log"
if [ "${1:-}" != "--noemail" ] && [ -n "${ALLORO_EMAIL_SERVICE_WEBHOOK:-}" ]; then
  SUBJECT="[Edge-block ENFORCED] ${VERDICT} -- watchdog day ${STREAK}"
  python3 - "$ALLORO_EMAIL_SERVICE_WEBHOOK" "${ALERT_EMAIL:-dave@getalloro.com}" "$SUBJECT" "$BODY" <<'PYMAIL'
import sys,json,urllib.request,html as _html
url,rcpts,subject,body=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
recips=[r.strip() for r in rcpts.split(",") if r.strip()]
body='<pre style="white-space:pre-wrap;word-wrap:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;line-height:1.5;color:#111;margin:0">'+_html.escape(body)+'</pre>'
payload={"subject":subject,"body":body,"recipients":recips,"cc":[],"bcc":[],"from":"info@getalloro.com","fromName":"Alloro Edge Block"}
req=urllib.request.Request(url,data=json.dumps(payload).encode(),headers={"Content-Type":"application/json"})
try:
    r=urllib.request.urlopen(req,timeout=30); print("emailed:",recips,"http",r.status)
except Exception as e: print("email FAILED:",e)
PYMAIL
fi
