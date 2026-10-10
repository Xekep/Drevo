// Run from repository root against tests/e2e-server.ts only.
const auditUrl = process.env.UI_AUDIT_URL || 'http://127.0.0.1:4191';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(auditUrl).hostname)) throw new Error('Use a disposable loopback E2E fixture.');
const auditOutput = process.env.UI_AUDIT_OUTPUT || require('node:path').join(process.cwd(), '.tmp-ui-audit');
require('node:fs').mkdirSync(auditOutput, { recursive: true });
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const req = createRequire(process.cwd() + '/package.json');
const { chromium } = req('playwright');
const out = auditOutput; fs.mkdirSync(out,{recursive:true});
async function metrics(page) {
 return page.evaluate(() => {
  const rgba=s=>{const m=s.match(/[\d.]+/g);return m ? m.map(Number):[255,255,255,1]};
  const blend=(a,b)=>a.slice(0,3).map((v,i)=>v*(a[3]??1)+b[i]*(1-(a[3]??1)));
  const bg=el=>{let stack=[];for(let e=el;e;e=e.parentElement)stack.push(rgba(getComputedStyle(e).backgroundColor));let b=[255,255,255];for(const c of stack.reverse())b=blend(c,b);return b};
  const lum=c=>c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);
  const visible=e=>{const b=e.getBoundingClientRect();const s=getComputedStyle(e);return b.width&&b.height&&b.bottom>0&&b.top<innerHeight&&b.right>0&&b.left<innerWidth&&s.visibility==='visible'&&s.display!=='none'};
  const text=[...document.querySelectorAll('button,a,label,small,p,span,h1,h2,h3,summary,b')].filter(e=>visible(e)&&[...e.childNodes].some(n=>n.nodeType===3&&n.textContent.trim())).map(e=>{const s=getComputedStyle(e), b=e.getBoundingClientRect(), fg=blend(rgba(s.color),bg(e)), l1=lum(fg),l2=lum(bg(e));return {text:e.textContent.trim().slice(0,100),cls:e.className,tag:e.tagName,font:s.fontSize,weight:s.fontWeight,color:s.color,background:bg(e),ratio:(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05),width:b.width,height:b.height,x:b.x,y:b.y,opacity:s.opacity}});
  const controls=[...document.querySelectorAll('button,input,select,textarea,summary,[role="tab"]')].filter(visible).map(e=>{const b=e.getBoundingClientRect(), s=getComputedStyle(e);return {name:e.getAttribute('aria-label')||e.textContent.trim().slice(0,60)||e.getAttribute('placeholder'),cls:e.className,tag:e.tagName,width:b.width,height:b.height,x:b.x,y:b.y,font:s.fontSize,disabled:!!e.disabled}});
  return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth-innerWidth,text,controls,scroll:[...document.querySelectorAll('*')].filter(e=>visible(e)&&e.scrollWidth>e.clientWidth+2&&e.clientWidth>50&&!e.closest('svg')).map(e=>({cls:e.className,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})).slice(0,30)};
 });
}
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 const context=await browser.newContext({viewport:{width:1440,height:900},baseURL:auditUrl,reducedMotion:'reduce'});
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 const results=[];
 async function shot(name,width){await page.setViewportSize({width,height:900});await page.waitForTimeout(200);await page.screenshot({path:path.join(out,`${name}-${width}.png`)});results.push({name,...await metrics(page)}); console.log(name,width);fs.writeFileSync(path.join(out,'metrics.json'),JSON.stringify({results,errors},null,2));}
 for(const route of ['tree','people','families','photos','documents','places','insights','resources','account','missing-page']){
  await page.goto('/'+route);await page.waitForTimeout(route==='places'?1300:550);
  for(const w of [1440,768,390,320])await shot(route,w);
 }
 await page.goto('/people/e2e-child');await page.waitForTimeout(750);
 for(const w of [1920,1440,1024,768,390,360,320])await shot('profile',w);
 await page.setViewportSize({width:1440,height:900});
 await page.locator('.inspector-person-actions .person-edit-button').click();await page.locator('.person-editor-form').waitFor();
 for(const w of [1440,1024,768,390,320])await shot('editor',w);
 await page.goto('/tree');await page.setViewportSize({width:1440,height:900});await page.getByRole('button',{name:'Хронология',exact:true}).click();await page.waitForTimeout(400);
 for(const w of [1440,768,390,320])await shot('timeline',w);
 await page.route('**/api/ai/status',r=>r.fulfill({json:{enabled:true,streaming:true}}));
 await page.route('**/api/ai/chat/stream',r=>r.fulfill({contentType:'text/event-stream',body:'event: done\ndata: '+JSON.stringify({answer:'Вот сведения о родственниках:\n\n| Человек | Годы жизни | Место рождения |\n|---|---|---|\n| Тестов Иван Петрович | 1940–2020 | Москва |\n| Тестов Пётр Иванович | 1965–н. в. | Москва |\n\n[Открыть человека](#drevo-person-e2e-child)\n\n```mermaid\ngraph LR\na["Иван 1940–2020"] -->|отец| b["Пётр 1965–н. в."]\n```',references:[],suggestionIds:[],uiActions:[],files:[]})+'\n\n'}));
 await page.goto('/tree');await page.setViewportSize({width:1440,height:900});await page.getByRole('button',{name:'Открыть ИИ-исследователя'}).click();
 await page.locator('.research-assistant textarea').fill('Покажи сведения и схему');await page.getByRole('button',{name:'Отправить запрос'}).click();await page.locator('.research-visual canvas').waitFor();
 for(const w of [1440,768,390,320])await shot('ai',w);
 await page.route('**/api/users?**',r=>r.fulfill({json:{users:[{id:'member',name:'Александра Константиновна Петрова',role:'reader',treeRole:'reader',approved:true,personId:'e2e-child',treeAccess:'common_ancestors',createdAt:'2026-01-01'}],total:1,next:null}}));
 await page.goto('/manage');await page.waitForTimeout(500);
 for(const w of [1440,1024,768,390,320])await shot('manage',w);
 await page.route('**/api/session',r=>r.fulfill({json:{user:null,account:{id:'admin',name:'Администратор',globalRole:'admin',fullAccess:true,provider:'email',createdAt:'2026-01-01'},local:false,email:true,yandex:false,vk:false}}));
 await page.route('**/api/platform/accounts*',r=>r.fulfill({json:{accounts:Array.from({length:8},(_,i)=>({id:'member-'+i,name:'Александра Константиновна Петрова '+i,role:i%2?'researcher':null,fullAccess:!!(i%2),lastVisitAt:'2026-10-09T18:00:00.000Z'})),next:null}}));
 await page.goto('/admin');await page.waitForTimeout(500);
 for(const w of [1440,1024,768,390,320])await shot('admin',w);
 await page.getByRole('navigation',{name:'Разделы админки платформы'}).getByRole('button',{name:'Yandex AI',exact:true}).click();await page.waitForTimeout(500);
 for(const w of [1440,768,390,320])await shot('admin-ai',w);
 await browser.close();console.log('DONE',errors);
})().catch(e=>{console.error(e);process.exit(1)});
