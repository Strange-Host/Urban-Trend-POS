import sys
from playwright.sync_api import sync_playwright
BASE='http://localhost:5173'
def login(page):
    page.goto(BASE+'/login'); page.wait_for_timeout(800)
    page.fill('input[type=email]','admin@urbantrends.com'); page.fill('input[type=password]','ChangeMe123!')
    page.keyboard.press('Enter'); page.wait_for_timeout(2000)
def run(w,h,tag,pages,bell=True):
    with sync_playwright() as p:
        b=p.chromium.launch(); ctx=b.new_context(viewport={'width':w,'height':h}); page=ctx.new_page()
        login(page)
        for path in pages:
            page.goto(BASE+path); page.wait_for_timeout(1500)
            name=path.strip('/').replace('/','_') or 'terminal'
            sx=page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            ov=page.evaluate("""()=>{const m=document.querySelector('main');return m? m.scrollWidth-m.clientWidth:null}""")
            print(tag,path,'doc-hscroll',sx,'main-hscroll',ov)
            page.screenshot(path=f'/tmp/shots/{tag}_{name}.png')
            if bell:
                btn=page.locator('button[aria-label^="Notifications"]:visible').first
                btn.click(); page.wait_for_timeout(600)
                page.screenshot(path=f'/tmp/shots/{tag}_{name}_bell.png')
                # who is on top at the centre of the dropdown?
                top=page.evaluate("""()=>{const d=document.querySelector('[role=dialog][aria-label=Notifications]'); if(!d) return 'no dialog';
                  const r=d.getBoundingClientRect(); const e=document.elementFromPoint(r.left+r.width/2, r.top+60);
                  return {rect:[Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)], topIsDialog:d.contains(e), topEl: e? e.tagName+'.'+String(e.className).slice(0,60):null}}""")
                print('   bell:',top)
                page.keyboard.press('Escape')
        b.close()
if __name__=='__main__':
    import os; os.makedirs('/tmp/shots',exist_ok=True)
    w,h,tag=int(sys.argv[1]),int(sys.argv[2]),sys.argv[3]
    run(w,h,tag,sys.argv[4:])
