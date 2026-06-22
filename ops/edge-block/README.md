# Renderer Edge Block (datacenter bot blocking)

Version-controlled **mirror** of the edge-bot-block tooling that runs on `alloro-renderer`
(the Caddy proxy in front of every client site). It blocks datacenter/cloud IP ranges at the
edge so headless-Chrome bots stop inflating client analytics, while allowlisting our own infra
plus Googlebot/Bing.

> **This directory is a reference mirror, not the deploy source.** The live copies run from
> `/opt/alloro/edge-block/` and `/etc/caddy/` on `alloro-renderer`. The renderer `deploy.yml`
> only touches `/home/ubuntu/website-renderer` — it never reads this folder — so editing here
> does **not** change the live block. To change the live block, edit on the box (see below) and
> copy changes back here. Canonical runbook: the Alloro repo at
> `plans/06172026-renderer-edge-bot-block/RUNBOOK.md` (also mirrored here as `RUNBOOK.md`).

## Files

| File | Role |
|---|---|
| `refresh-cidrs.sh` | Fetches published cloud ranges → `datacenter-cidrs.txt` (AWS/GCP-compute/DO/Oracle) + `allowed-cidrs.txt` (our 9 Elastic IPs + Googlebot + Bing). Weekly cron. |
| `gen-caddy-snippet.sh` | Reads those two lists → emits `/etc/caddy/snippets/edge-block.caddy` (the `(edge_block)` matcher snippet). Run before enforcing / after a list refresh. |
| `analyze-dryrun.py` / `.sh` | Reads the Caddy access log, computes the would-block / blocked set, rDNS-verifies any Googlebot/Bing in it (the hard SEO gate), and emails a daily verdict. Now the post-enforce **watchdog**. |
| `Caddyfile` | Snapshot of the live, **enforced** `/etc/caddy/Caddyfile` (globals + `import edge_block` inside the `https://` block). |
| `.env.example` | Template for the runtime config (real `.env` lives only on the box, `chmod 600`, never committed). |
| `RUNBOOK.md` | Full record + step-by-step enforce/rollback/monitoring. |

Generated artifacts are intentionally **not** committed: `datacenter-cidrs.txt`,
`allowed-cidrs.txt`, `edge-block.caddy`, and the `*.log` / `clean-streak.txt` runtime state.
Regenerate with `refresh-cidrs.sh` then `gen-caddy-snippet.sh`.

## How the block works

Inside the renderer's single `https://` site block, the snippet returns **403** when a request
is **(in a datacenter range) AND (not in the allowlist) AND (not an ACME challenge path)**;
everything else proxies to `localhost:7777` as normal. Real patients (ISP/mobile) and crawlers
(Google/MS/Apple networks) are structurally never in the blocklist, and crawlers are explicitly
allowlisted on top of that.

## Crontab (ubuntu @ alloro-renderer)

```
0 3 * * 0   /opt/alloro/edge-block/refresh-cidrs.sh   >> /opt/alloro/edge-block/refresh.log 2>&1   # weekly list refresh
13 13 * * * /opt/alloro/edge-block/analyze-dryrun.sh  >> /opt/alloro/edge-block/cron.log 2>&1       # daily watchdog email
```

## Enforce / rollback (live, on the box)

```bash
ssh alloro-renderer
/opt/alloro/edge-block/refresh-cidrs.sh && /opt/alloro/edge-block/gen-caddy-snippet.sh
sudo chmod 644 /etc/caddy/snippets/edge-block.caddy     # caddy user must be able to read it
sudo cp -a /etc/caddy/Caddyfile /home/ubuntu/caddy-backups/Caddyfile.$(date +%Y%m%d-%H%M%S).bak
# ...ensure the Caddyfile imports the snippet (see Caddyfile here)...
sudo systemctl restart caddy        # restart, NOT reload (reload wedges this box)
# rollback: sudo cp /home/ubuntu/caddy-backups/Caddyfile.<TS>.bak /etc/caddy/Caddyfile && sudo systemctl restart caddy
```

## Landmines

- **`systemctl reload caddy` wedges this box** — always `restart` (~1–2s blip).
- **The snippet must be world-readable (`644`).** `gen-caddy-snippet.sh` chmods it; a `root:root 600`
  snippet makes the caddy *service user* fail with "permission denied" at start — and
  `caddy validate` runs as root (which can read 600), so it **passes validation but fails at runtime**.
- **Never `caddy validate` a config that opens the access log** as root — it creates a root-owned
  `access.log` the caddy user can't write, which jams startup. Validate a no-log variant instead.
