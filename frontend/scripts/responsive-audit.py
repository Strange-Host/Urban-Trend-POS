# Dev-only browser check (needs: pip install playwright; playwright install chromium; backend + vite running).
# Usage: python3 responsive-audit.py <width> <height> <tag>   - flags pages that overflow sideways.
import sys, os
from playwright.sync_api import sync_playwright
sys.path.insert(0,__import__('os').path.dirname(__file__)); from shot import login, BASE
PAGES=['/','/dashboard','/orders','/leads','/sales','/catalog','/shopify-sync','/finance','/reconciliation','/requisitions','/attendance','/payroll','/staff','/employees','/staff-logs','/settings']
JS="""()=>{
 const vw=document.documentElement.clientWidth; const out=[];
 const scrolls=(el)=>{for(let n=el.parentElement;n;n=n.parentElement){const cs=getComputedStyle(n); if(['auto','scroll'].includes(cs.overflowX)&&n.scrollWidth>n.clientWidth) return true;} return false;};
 document.querySelectorAll('main *').forEach(el=>{const r=el.getBoundingClientRect(); if(r.width===0||r.height===0) return; if(el.closest('thead') && vw<640) return;
   if(r.right>vw+1 && !scrolls(el)){ out.push(el.tagName+'.'+String(el.className).replace(/\\s+/g,'.').slice(0,60)+' right='+Math.round(r.right)); }});
 const clip=[]; document.querySelectorAll('main .overflow-x-auto').forEach(el=>{ if(el.scrollWidth>el.clientWidth+1) clip.push(Math.round(el.scrollWidth)+'>'+Math.round(el.clientWidth)); });
 return {vw, over:[...new Set(out)].slice(0,4), scrollers:clip};}"""
os.makedirs('/tmp/shots',exist_ok=True)
w,h,tag=int(sys.argv[1]),int(sys.argv[2]),sys.argv[3]
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':w,'height':h},has_touch=w<800); page=ctx.new_page(); login(page)
    for path in PAGES:
        page.goto(BASE+path); page.wait_for_timeout(1300)
        r=page.evaluate(JS); name=path.strip('/').replace('/','_') or 'terminal'
        page.screenshot(path=f'/tmp/shots/{tag}_{name}.png', full_page=False)
        print(f'{path:15}', 'OVERFLOW' if r['over'] else 'ok', r['over'][:3], 'scrollTables:',r['scrollers'])
    b.close()
