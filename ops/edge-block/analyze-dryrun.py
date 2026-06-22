#!/usr/bin/env python3
import sys, json, time, ipaddress, bisect, collections, socket
DIR="/opt/alloro/edge-block"; WINDOW=24*3600
def load_nets(p):
    nets=[]
    try:
        for ln in open(p):
            ln=ln.strip()
            if ln:
                try: nets.append(ipaddress.ip_network(ln,strict=False))
                except ValueError: pass
    except FileNotFoundError: pass
    return nets
def index(nets):
    v4=ipaddress.collapse_addresses([n for n in nets if n.version==4])
    v6=ipaddress.collapse_addresses([n for n in nets if n.version==6])
    return (sorted((int(n.network_address),int(n.broadcast_address)) for n in v4),
            sorted((int(n.network_address),int(n.broadcast_address)) for n in v6))
def member_fn(idx):
    r4,r6=idx; s4=[a for a,_ in r4]; e4=[b for _,b in r4]; s6=[a for a,_ in r6]; e6=[b for _,b in r6]
    def m(ipstr):
        try: ip=ipaddress.ip_address(ipstr)
        except ValueError: return False
        x=int(ip)
        if ip.version==4:
            i=bisect.bisect_right(s4,x)-1; return i>=0 and e4[i]>=x
        i=bisect.bisect_right(s6,x)-1; return i>=0 and e6[i]>=x
    return m
dc=member_fn(index(load_nets(DIR+"/datacenter-cidrs.txt")))
al=member_fn(index(load_nets(DIR+"/allowed-cidrs.txt")))
cutoff=time.time()-WINDOW
total=win=0
wb=collections.Counter(); paths=collections.defaultdict(set); post=collections.defaultdict(bool); ua={}
ENG=("/consultation","/contact","/appointment","/request","/book")
for line in sys.stdin:
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except ValueError: continue
    if not d.get("logger","").startswith("http.log.access"): continue
    total+=1
    if d.get("ts",0)<cutoff: continue
    win+=1
    req=d.get("request",{}); ip=req.get("client_ip") or req.get("remote_ip")
    if not ip: continue
    uri=(req.get("uri","") or "").split("?")[0]; paths[ip].add(uri)
    h=req.get("headers",{}) or {}; u=h.get("User-Agent",[""]); ua[ip]=u[0] if isinstance(u,list) and u else ""
    if req.get("method")=="POST" or any(p in uri for p in ENG): post[ip]=True
    if dc(ip) and not al(ip): wb[ip]+=1
def rdns(ip):
    try: host=socket.gethostbyaddr(ip)[0].lower()
    except Exception: return None
    if host.endswith("googlebot.com") or host.endswith(".google.com") or host.endswith("search.msn.com") or host.endswith(".msn.com"):
        try:
            _,_,addrs=socket.gethostbyname_ex(host)
            if ip in addrs: return host
        except Exception: return None
    return None
if win==0:
    print(json.dumps({"verdict":"NO-DATA","clean":False,"text":"NO-DATA: no access-log lines in the last 24h window"})); sys.exit(0)
crawlers=[]; review=[]
for ip,hits in wb.most_common(500):
    v=rdns(ip)
    if v: crawlers.append((ip,hits,v))
for ip,hits in wb.most_common():
    if post[ip] or len(paths[ip])>=4:
        review.append((ip,hits,len(paths[ip]),"FORM-POST" if post[ip] else "multi-page",ua.get(ip,"")[:46]))
wbt=sum(wb.values())
# HARD GATE = SEO only (rDNS-verified crawler in would-block). Real-user safety is structural
# (real users are on ISP/mobile, never in the datacenter would-block set) + the REVIEW glance below.
clean=(len(crawlers)==0); verdict="CLEAN" if clean else "NOT-CLEAN"
L=[f"Edge-block dry-run -- verdict: {verdict}",
   f"window: last 24h | access lines (window/total): {win}/{total}",
   f"would-block: {wbt} requests from {len(wb)} unique IPs",""]
L.append(f"[SEO GATE] verified Googlebot/Bing in would-block set: {len(crawlers)}  (must be 0 to enforce)")
for ip,h,host in crawlers[:25]: L.append(f"   !! {ip} -> {host} (x{h})  <-- REAL CRAWLER: DO NOT ENFORCE, add to allowlist")
L.append("")
L.append(f"[REVIEW] would-block IPs with form-POST/multi-page activity: {len(review)} (expected: all bots; glance to confirm none are real people)")
for ip,h,np,kind,u in review[:25]: L.append(f"   {ip} x{h} paths={np} {kind} ua={u}")
L.append("")
L.append("top would-block IPs:")
for ip,h in wb.most_common(12): L.append(f"   {ip} x{h} paths={len(paths[ip])} {ua.get(ip,'')[:46]}")
print(json.dumps({"verdict":verdict,"clean":clean,"text":"\n".join(L)}))
