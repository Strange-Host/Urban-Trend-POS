# Dev-only: opens the notification bell on every page and reports whether anything covers the panel.
# Usage: python3 bell-overlap-sweep.py <width> <height> <tag>
import sys, os
from playwright.sync_api import sync_playwright
sys.path.insert(0,__import__('os').path.dirname(__file__)); from shot import login, BASE
PAGES=['/','/dashboard','/orders','/leads','/sales','/catalog','/shopify-sync','/finance','/reconciliation','/requisitions','/attendance','/payroll','/staff','/employees','/staff-logs','/settings']
JS="""()=>{const d=document.querySelector('[role=dialog][aria-label=Notifications]'); if(!d) return 'no dialog';
 const r=d.getBoundingClientRect(); const bad=[];
 for(const fx of [0.1,0.5,0.9]) for(const fy of [0.05,0.5,0.95]){
   const x=r.left+r.width*fx,y=r.top+r.height*fy; const e=document.elementFromPoint(x,y);
   if(!d.contains(e)) bad.push([Math.round(x),Math.round(y),e?e.tagName+'.'+String(e.className).slice(0,50):null]);}
 return {rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)],covered:bad}}"""
w,h,tag=int(sys.argv[1]),int(sys.argv[2]),sys.argv[3]
os.makedirs('/tmp/shots',exist_ok=True)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':w,'height':h},has_touch=w<800); page=ctx.new_page(); login(page)
    for path in PAGES:
        page.goto(BASE+path); page.wait_for_timeout(1200)
        hs=page.evaluate("document.documentElement.scrollWidth-document.documentElement.clientWidth")
        mh=page.evaluate("(()=>{const m=document.querySelector('main');return m?m.scrollWidth-m.clientWidth:null})()")
        res='-'
        btn=page.locator('button[aria-label^="Notifications"]:visible').first
        if btn.count():
            btn.click(); page.wait_for_timeout(400); res=page.evaluate(JS)
            name=path.strip('/').replace('/','_') or 'terminal'
            page.screenshot(path=f'/tmp/shots/{tag}_{name}_bell.png'); page.keyboard.press('Escape')
        print(f'{tag} {path:15} hscroll={hs} main={mh} bell={res}')
    b.close()
