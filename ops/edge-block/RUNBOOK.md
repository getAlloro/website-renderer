# One Endodontics Bot Traffic — Knowledge Base & Enforce Runbook

**Plan folder:** `plans/06172026-renderer-edge-bot-block/`
**Created:** 2026-06-18 · **Spec:** [`spec.html`](spec.html)
**Status:** ✅ **ENFORCED 2026-06-22 — block LIVE.** T1–T5 done + data cleanup done. Gate was called at **5/5** clean days (owner decision; justified by structural exclusion + allowlist + watchdog + instant rollback, with verified Googlebot passing 200 in live logs). Now in **post-enforce monitoring (§9)** — the daily email is the watchdog.

> This is the full record of the bot-traffic work — what we found, what we cleaned, what we built, and **how blocking (T5) was turned on.** Post-enforce, the daily watchdog email is the alarm; rollback is §8 step 7 / §10.
>
> **Enforce-day notes (2026-06-22):** the snippet generator (`gen-caddy-snippet.sh`, §8 step 1) was built; the first flip **failed** because the generated snippet was `root:root 600` (caddy service user couldn't read it — `caddy validate` runs as root and passed, masking it), auto-rollback restored service in ~3s, fix was `chmod 644` + generator patched. Verified: 403 → datacenter only, Googlebot/Bing 200, zero false positives. Cleanup dropped One Endo June 7,476 → 1,013 users (baseline); Garrison/Artful were not inflated.

---

## 1. TL;DR

- One Endodontics' dashboard showed **~20,600 "visitors" in June**. **~95% were bots** — headless Chrome running in an **AWS Oregon (us-west-2) datacenter** — not real people. Real human traffic ≈ **1,300/mo**, flat vs April/May.
- We **cleaned the historical data** (self-hosted Rybbit's ClickHouse + our Postgres) so the dashboard reads **~1,341** today.
- Bots keep arriving, so the number **re-inflates daily** until we block them at the edge.
- **Durable fix:** block datacenter/cloud IP ranges at the **renderer's Caddy** (the proxy in front of *all* client sites), while allowlisting **our own infra + Googlebot/Bing**.
- We're in a **7-day dry-run** (observe only, nothing blocked). A daily email reports a CLEAN/NOT-CLEAN verdict + a clean-day streak. **After 7 CLEAN days, manually run T5** (§8) to enforce.

---

## 2. The problem — how we know it's bots

Pulled live from self-hosted Rybbit (analytics) for site_id 7 (1endodontics.com):

| Month | Visitors | Sessions | Sessions/visitor |
|---|---|---|---|
| Apr | 1,374 | 1,788 | 1.3 |
| May | 1,197 | 1,424 | 1.2 |
| **Jun (17 days)** | **21,180** | **71,868** | **3.4** |

Bot signature (2,000-session sample): **94.7% city = Boardman, Oregon** (AWS us-west-2 datacenter), **96.4% OS = Linux**, **98% Direct/no-referrer**, **98.5% homepage-only**, **88.8% zero-second single-pageview**, **0 form submits / 0 button clicks**. Started abruptly **June 2** (June 1 was normal at 49 visitors).

Rybbit's `blockBots: true` missed them because it filters by *known bot user-agents*; these send a **real Chrome UA** (headless Chrome). The real human remainder (~5%) is local Northern Virginia traffic (Arlington, Alexandria, Falls Church) — consistent with the baseline.

There's also a second, lower-volume population: **internet-wide vulnerability scanners** hitting every client site probing `/.env`, `/.git/config`, `/adminer.php` with scanner + spoofed-AI-bot UAs. No secrets leak (the renderer returns the SPA `index.html` 200 for any path).

**Leads reality:** prod has 29 real June leads (all Northern-VA residential IPs). The dev dashboard's "6 leads" was just dev-DB staleness.

---

## 3. What we already cleaned (DONE 2026-06-17)

Rybbit is **self-hosted** on `ssh alloro-analytics` (Docker: clickhouse/postgres/backend/client/caddy). Event data = ClickHouse `analytics.events`.

- **Backed up** 99,609 June-Oregon rows → `/home/ubuntu/events_bak_site7_or.native` (26.7 MB) **and** table `analytics.events_bak_site7_or`.
- **Deleted:** `DELETE FROM analytics.events WHERE site_id=7 AND region='US-OR' AND timestamp >= '2026-06-01' AND timestamp < '2026-07-01'`. June 21,283 → **1,345 users**.
- **Live Rybbit API** now returns ~1,341 for June (headline auto-corrected).
- **Re-harvested** our Postgres `website_builder.rybbit_data` June 1–16 (in-process on `alloro-app`, replaying the real harvest path) → daily rows now 49–152 users/day (was 764–2,525).

**To restore the deleted rows if ever needed** (on `alloro-analytics`):
```bash
# from the backup table:
sudo docker exec clickhouse clickhouse-client -q "INSERT INTO analytics.events SELECT * FROM analytics.events_bak_site7_or"
# OR from the native file:
sudo docker exec -i clickhouse clickhouse-client -q "INSERT INTO analytics.events FORMAT Native" < /home/ubuntu/events_bak_site7_or.native
```

⚠️ **This was a one-time scrub, not a fix.** Bots keep hitting; June re-inflates daily until T5 enforce lands. Other client sites (Caswell, Garrison, Surf City, Tri-City) likely have the same inflation and were **not** cleaned.

---

## 4. The fix — architecture & why it's safe

**Block by network origin (ASN/CIDR), not geography or OS.** Real patients come from ISP/mobile networks; these bots come from cloud compute. That signal doesn't change when bots swap region or fake a UA.

**Approach B (chosen):** block published cloud/hosting CIDR ranges (AWS + GCP + DigitalOcean + Oracle now; Azure/Hetzner/OVH best-effort later) using **native Caddy `remote_ip` matchers** (no custom binary), on **all client sites**, with an allowlist.

**Two safety guarantees (proven in testing):**
1. **SEO safe** — Googlebot/Bing run on Google/Microsoft networks, *not* the blocked clouds, so they're structurally never in the blocklist; they're *also* explicitly allowlisted by published ranges; and the dry-run/monitor fails loudly if a verified crawler ever lands in the would-block set.
2. **Real users safe** — real patients are on ISP/mobile networks, never in the datacenter blocklist, so they pass through untouched.

**Allowlist = our 9 Elastic IPs + Googlebot + Bing.** Our own AWS-hosted audit scraper (`52.203.199.155`) is in the AWS blocklist *and* the allowlist; the rule is "datacenter **AND NOT** allowlisted," so it passes. **Verified membership check:**

| IP | Who | In blocklist | In allowlist | Result |
|---|---|---|---|---|
| 44.252.48.166 | AWS bot | yes | no | blocked |
| 66.249.66.1 | Googlebot | **no** | yes | never blocked |
| 52.203.199.155 | our app | yes | yes | allowed |
| 138.84.104.127 | real mobile | **no** | no | passes |

---

## 5. Infrastructure map

| Box | SSH alias | IP (EIP) | Role |
|---|---|---|---|
| Renderer | `ssh alloro-renderer` | 54.159.199.33 | **Serves all client sites** (Caddy → pm2 `website-builder` :7777). **Edge block lives here.** |
| App/API | `ssh alloro-app` | 52.203.199.155 | Backend API + worker; prod Postgres; Rybbit API key. |
| Analytics | `ssh alloro-analytics` | 23.23.202.251 | Self-hosted Rybbit (Docker: ClickHouse + Postgres). |
| Site/nginx | `ssh alloro-site` | 3.210.251.123 | Docs/audit static host (separate). |
| Dev | `ssh alloro-dev` | 3.210.41.226 | Dev app. |
| Sandbox | `ssh alloro-sandbox` | 44.220.215.37 | Sandbox. |

**Renderer topology:** client domains (e.g. `1endodontics.com`) → GoDaddy DNS → **54.159.199.33** (no Cloudflare) → Caddy `:443` (system service, on-demand TLS via `ask :7777/verify-domain`) → pm2 `website-builder` `:7777`.

**Renderer deploy is separate from the edge block.** App repo = `Hamiltonwise/website-renderer` (local: `~/Desktop/website-builder-rebuild`), `deploy.yml` wipes/uploads only `/home/ubuntu/website-renderer` + reloads PM2. It **never touches `/etc/caddy` or `/opt/alloro`**, so the edge artifacts are **deploy-safe** (but currently untracked — see §12).

**Our 9 Elastic IPs (allowlist):** `18.213.168.139`, `23.20.182.194` (N8N), `23.23.202.251` (Rybbit), `3.210.251.123` (AuditTool/Docs), `3.210.41.226` (Dev), `44.220.215.37` (Sandbox), `52.203.199.155` (App), `54.159.199.33` (Renderer), `54.197.53.133`. (A 10th existed in the AWS console but was intentionally disregarded.)

---

## 6. What's deployed right now (T1–T4)

All under `/opt/alloro/edge-block/` on `alloro-renderer`:

| File | Purpose |
|---|---|
| `refresh-cidrs.sh` | Fetches published ranges → `datacenter-cidrs.txt` (13,898 CIDRs: AWS/GCP/DO/Oracle) + `allowed-cidrs.txt` (352: 9 EIPs + Googlebot + Bing). Best-effort per source. |
| `datacenter-cidrs.txt` / `allowed-cidrs.txt` | The generated lists. |
| `analyze-dryrun.py` | Reads access log (stdin) vs the lists → "would-block" set; rDNS-verifies any Googlebot/Bing in it; flags form-POST/multi-page; emits CLEAN/NOT-CLEAN. Fast (collapsed-range binary search). |
| `analyze-dryrun.sh` | Wrapper: gathers logs via `sudo`, runs the analyzer, tracks the clean-day streak, prepends the T5 reminder, emails via the n8n webhook. |
| `.env` (0600) | `ALLORO_EMAIL_SERVICE_WEBHOOK` + `ALERT_EMAIL` (dave@ + info@getalloro.com). |
| `clean-streak.txt` | `YYYY-MM-DD STREAK` — consecutive CLEAN-day counter. |
| `dryrun-history.log` / `cron.log` / `refresh.log` | Run history + cron output. |

**Caddy change (T1):** the `https://` block gained a JSON `log` → `/var/log/caddy/access.log` (owned `caddy:caddy 0600`, rolls at 100 MiB). **No blocking yet.**

**Crons (ubuntu):**
```
0 3 * * 0   /opt/alloro/edge-block/refresh-cidrs.sh   >> .../refresh.log 2>&1   # weekly list refresh
13 13 * * * /opt/alloro/edge-block/analyze-dryrun.sh  >> .../cron.log 2>&1      # daily analyze + email
```

---

## 7. The dry-run gate

- **Daily email** (13:13 UTC) to dave@ + info@getalloro.com. Subject: `[Edge-block dry-run] CLEAN -- day N/7`.
- Each email leads with the rollout status, the **clean-day streak (N/7)**, and the T5 reminder.
- **CLEAN** = zero rDNS-verified Googlebot/Bing in the would-block set (the hard SEO gate). The REVIEW list (multi-page/form-POST datacenter IPs) is **informational** — expected to be all bots (`kinsta-bot`, `MainWP`, `GuzzleHttp`, datacenter Chrome); glance to confirm none are real people.
- **NOT-CLEAN** = a verified crawler appeared in the would-block set → **do not enforce**; add it to the allowlist and the streak resets.
- **Gate to enforce:** 7 consecutive CLEAN days. The email flips to `>>> READY TO ENFORCE` at 7.

---

## 8. T5 — ENFORCE RUNBOOK ⭐ (the action, when ready)

**Pre-req:** the daily email shows `>>> READY TO ENFORCE` (7 consecutive CLEAN days). Re-skim the latest REVIEW list to confirm it's all bots.

> Note: T5 still needs one build step — extend `refresh-cidrs.sh` to also emit a Caddy **matcher snippet** from the CIDR lists (it currently emits only the `.txt` lists). Steps below include it.

### Step 0 — connect & refresh
```bash
ssh alloro-renderer
/opt/alloro/edge-block/refresh-cidrs.sh        # ensure lists are current
```

### Step 1 — generate Caddy matcher snippets from the lists
Produce `/etc/caddy/snippets/edge-block.caddy` containing named matchers with the CIDRs inlined, e.g.:
```
# generated — do not hand-edit
(edge_block) {
    @acme path /.well-known/acme-challenge/*
    handle @acme { reverse_proxy localhost:7777 }

    @blocked {
        remote_ip <all datacenter CIDRs, space-separated>
        not remote_ip <all allowed CIDRs, space-separated>
    }
    handle @blocked { respond 403 }
}
```
(Generate by reading `datacenter-cidrs.txt` / `allowed-cidrs.txt` into the `remote_ip` lines.)

### Step 2 — back up the working Caddyfile (OUTSIDE /etc/caddy)
```bash
sudo cp -a /etc/caddy/Caddyfile /home/ubuntu/caddy-backups/Caddyfile.$(date +%Y%m%d-%H%M%S).bak
```

### Step 3 — wire the block into `/etc/caddy/Caddyfile`
Inside the existing `https://` block, **before** the final `reverse_proxy`, import + invoke the block (allowlist/ACME handled inside the snippet so they win):
```
https:// {
    log { output file /var/log/caddy/access.log { roll_size 100MiB roll_keep 10 } format json }
    tls { on_demand }
    import edge_block            # <-- ACME exempt + @blocked -> 403
    reverse_proxy localhost:7777 # default for everyone allowed through
}
```
(Add `import /etc/caddy/snippets/edge-block.caddy` at the top global scope if using a snippet file.)

### Step 4 — validate (mind the gotcha)
```bash
# ensure the access log exists as caddy:caddy first so validate-as-root doesn't recreate it root-owned
sudo ls -l /var/log/caddy/access.log    # must be caddy:caddy
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
sudo chown caddy:caddy /var/log/caddy/access.log 2>/dev/null || true
```

### Step 5 — apply via RESTART (reload wedges on this box — see §11)
```bash
sudo systemctl restart caddy      # ~1-2s all-sites blip
systemctl is-active caddy         # expect: active
```

### Step 6 — verify
```bash
# client sites still serve (via localhost, fast):
for h in www.1endodontics.com caswellorthodontics.com garrisonorthodontics.com surfcityendo.com tricity-endo.com; do
  curl --resolve "$h:443:127.0.0.1" -s -o /dev/null -m 8 -w "$h: %{http_code}\n" "https://$h/"
done
# ACME path reachable (not blocked):
curl --resolve www.1endodontics.com:443:127.0.0.1 -s -o /dev/null -w "acme: %{http_code}\n" "https://www.1endodontics.com/.well-known/acme-challenge/test"
# after a few minutes, confirm 403s are going to datacenter IPs and NOT to crawlers/real users:
sudo grep '"status":403' /var/log/caddy/access.log | tail -20
```
Expect: all client domains 200, ACME path 200/404 (reachable), 403s only to datacenter IPs.

### Step 7 — rollback (if anything's wrong)
```bash
sudo cp /home/ubuntu/caddy-backups/Caddyfile.<TS>.bak /etc/caddy/Caddyfile
sudo systemctl restart caddy
```
Instant return to the known-good (pre-block) config.

---

## 9. T6 — monitoring after enforce

- **Google Search Console** (1endodontics + other sites): watch for crawl-error spikes for ~1 week.
- **rDNS alert:** the analyzer already flags any 403 to a verified Googlebot/Bing IP — keep the daily email running post-enforce as the watchdog.
- **Rybbit:** confirm new-day visitor volume drops to baseline (~40–60/day/site) and stays there.
- **Caddy health:** all sites 200.
- If a legit datacenter caller (e.g., a new SEO tool, an unfurler) is wrongly blocked, add its published ranges/IP to `allowed-cidrs.txt` (via `refresh-cidrs.sh`) and restart.

---

## 10. Full rollback (remove the edge block entirely)

```bash
ssh alloro-renderer
sudo cp /home/ubuntu/caddy-backups/Caddyfile.<original-TS>.bak /etc/caddy/Caddyfile   # original had no block
sudo systemctl restart caddy
crontab -l | grep -v edge-block | crontab -      # stop the crons (optional)
```
The original backup from T1 is `Caddyfile.20260617-141610.bak` (access-logging only) — earlier ones (if any) are pre-access-log.

---

## 11. Gotchas / landmines (learned the hard way)

1. **Never run `sudo caddy validate` against a config that opens the log file** — validate (as root) *creates* `/var/log/caddy/access.log` owned by root; the caddy-user service then can't write it and the reload **hangs/times out**. Ensure the log exists as `caddy:caddy` first, or validate a config without the log directive.
2. **`systemctl reload caddy` WEDGES on this box** — it times out and leaves the unit stuck "reloading" while the old config keeps serving. **Use `systemctl restart caddy`** (~1–2s blip) for config changes.
3. **`access.log` is `caddy:caddy 0600` and rolls at 100 MiB** — read it via passwordless `sudo` (the analyzer does `sudo cat`/`sudo zcat` across rolled files). Don't assume `ubuntu` can read it directly.
4. **Crontab edits + `set -e`** — an empty crontab makes `crontab -l | grep ...` exit non-zero; under `set -e` that aborts the subshell and can install an *empty* crontab. Guard with `|| true`.
5. **Engagement ≠ real user inside the datacenter set** — multi-page/form-POST from a datacenter IP is a sophisticated bot, not a human (real humans aren't on datacenter IPs). The gate is the rDNS crawler check, not engagement.
6. **GCP:** block `gstatic.com/ipranges/cloud.json` (compute), **not** `goog.json` (Google services, which includes crawlers).

---

## 12. Open items / TODO

- [ ] **T5 enforce** — after 7 CLEAN days (see §8). The only step that changes serving.
- [ ] **Build the snippet generator** — extend `refresh-cidrs.sh` to emit `/etc/caddy/snippets/edge-block.caddy` (§8 step 1).
- [ ] **Version-control the artifacts** — mirror `Caddyfile`, `refresh-cidrs.sh`, `analyze-dryrun.*`, this runbook into the `website-renderer` repo under `ops/edge-block/` (they're deploy-safe but currently untracked).
- [ ] **Other client sites** — same bot inflation likely on Caswell/Garrison/Surf City/Tri-City Rybbit data; clean if desired (the block fixes it going forward for all).
- [ ] **Broaden coverage** — add Azure / Hetzner / OVH ranges to the blocklist if bots hop clouds (dry-run/monitor will show it).
- [ ] **Future hardening** — MaxMind ASN-by-number blocking (cleaner than CIDR lists, needs a custom Caddy build); proof-of-work challenge (e.g. Anubis) if bots ever move to residential IPs.

---

## 13. Quick reference — commands

```bash
# run today's dry-run analysis on demand (no email):
ssh alloro-renderer '/opt/alloro/edge-block/analyze-dryrun.sh --noemail'
# see the clean-day streak:
ssh alloro-renderer 'cat /opt/alloro/edge-block/clean-streak.txt'
# read the dry-run history:
ssh alloro-renderer 'tail -100 /opt/alloro/edge-block/dryrun-history.log'
# refresh the IP lists now:
ssh alloro-renderer '/opt/alloro/edge-block/refresh-cidrs.sh'
# live verdict for One Endo from Rybbit (run on alloro-app):
ssh alloro-app 'set -a; . /etc/alloro/app.env; set +a; curl -s -H "Authorization: Bearer $RYBBIT_API_KEY" "$RYBBIT_API_URL/api/sites/7/overview?start_date=2026-06-01&end_date=2026-06-30&time_zone=America/New_York"'
```
