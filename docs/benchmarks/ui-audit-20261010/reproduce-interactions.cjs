// Run from repository root against tests/e2e-server.ts only.
const auditUrl = process.env.UI_AUDIT_URL || 'http://127.0.0.1:4191';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(auditUrl).hostname)) throw new Error('Use a disposable loopback E2E fixture.');
const auditOutput = process.env.UI_AUDIT_OUTPUT || require('node:path').join(process.cwd(), '.tmp-ui-audit');
require('node:fs').mkdirSync(auditOutput, { recursive: true });
const fs=require('node:fs'),{createRequire}=require('node:module');
const req=createRequire(process.cwd() + '/package.json');const {chromium}=req('playwright');const PDF=req('pdfkit');
const out=auditOutput;
(async()=>{
const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
const evidence={};
const c=await browser.newContext({baseURL:auditUrl,viewport:{width:1440,height:900},reducedMotion:'reduce'});const p=await c.newPage();
const geo=()=>p.evaluate(()=>({viewport:{w:innerWidth,h:innerHeight},transform:document.querySelector('.react-flow__viewport')?.style.transform,nodes:[...document.querySelectorAll('.flow-person-content')].map(e=>{const b=e.getBoundingClientRect();return {name:e.getAttribute('aria-label'),x:b.x,y:b.y,w:b.width,h:b.height,visible:b.right>0&&b.left<innerWidth&&b.bottom>58&&b.top<innerHeight}}),controls:[...document.querySelectorAll('.tree-canvas button')].filter(e=>{const b=e.getBoundingClientRect();return b.width&&b.height}).map(e=>e.getAttribute('aria-label')||e.textContent)}));
await p.goto('/tree');await p.waitForTimeout(1500);evidence.resizeBefore=await geo();
await p.setViewportSize({width:390,height:844});await p.waitForTimeout(2500);evidence.resizeAfter=await geo();await p.screenshot({path:out+'/resize-empty-390.png'});
await p.reload();await p.waitForTimeout(1500);evidence.freshMobile=await geo();await p.screenshot({path:out+'/fresh-tree-390.png'});
await p.setViewportSize({width:1440,height:900});await p.reload();await p.waitForTimeout(800);
await p.route('**/api/ai/status',r=>r.fulfill({json:{enabled:true,streaming:true}}));
await p.route('**/api/ai/chats',r=>r.fulfill({json:{chats:[{id:'audit-chat-a',title:'Поиск прадеда'},{id:'audit-chat-b',title:'Документы семьи'}]}}));
await p.route('**/api/ai/chats/audit-chat-*',r=>r.fulfill({json:{messages:[{role:'assistant',content:'Тестовый диалог. Это синтетические данные.'}]}}));
await p.goto('/tree');await p.waitForTimeout(650);const launch=p.getByRole('button',{name:'Открыть ИИ-исследователя'});await launch.focus();await p.keyboard.press('Enter');await p.waitForTimeout(200);
evidence.aiOpenFocus=await p.evaluate(()=>({tag:document.activeElement.tagName,cls:document.activeElement.className,aria:document.activeElement.getAttribute('aria-label')}));
evidence.aiTabs=[];for(let i=0;i<8;i++){await p.keyboard.press('Tab');evidence.aiTabs.push(await p.evaluate(()=>({tag:document.activeElement.tagName,cls:document.activeElement.className,aria:document.activeElement.getAttribute('aria-label')})));}
await p.getByRole('button',{name:'Выбрать диалог'}).click();await p.getByRole('button',{name:'Поиск прадеда',exact:true}).click();await p.waitForTimeout(150);
await p.locator('.research-assistant textarea').fill('Несохранённый запрос: найди документы о моём прадеде за 1914 год');
evidence.draftBefore=await p.locator('.research-assistant textarea').inputValue();
await p.getByRole('button',{name:'Выбрать диалог'}).click();await p.getByRole('button',{name:'Документы семьи',exact:true}).click();await p.waitForTimeout(100);
await p.getByRole('button',{name:'Выбрать диалог'}).click();await p.getByRole('button',{name:'Поиск прадеда',exact:true}).click();await p.waitForTimeout(100);
evidence.draftAfter=await p.locator('.research-assistant textarea').inputValue();await p.screenshot({path:out+'/ai-draft-lost-1440.png'});
await p.setViewportSize({width:390,height:844});await p.goto('/people/e2e-child');await p.waitForTimeout(400);
await p.getByRole('button',{name:'Закрыть панель',exact:true}).focus();await p.keyboard.press('Tab');evidence.profileTabAfterClose=await p.evaluate(()=>({tag:document.activeElement.tagName,cls:document.activeElement.className,aria:document.activeElement.getAttribute('aria-label')}));
await p.locator('.nav-account').click();evidence.modalHeader=await p.evaluate(()=>({modal:document.querySelector('.inspector-dock')?.getAttribute('aria-modal'),menuOpen:document.querySelector('.archive-more')?.open,active:document.activeElement.className,headerInert:document.querySelector('.archive-header')?.inert}));
await p.keyboard.press('Escape');await p.getByRole('button',{name:'Изменить человека',exact:true}).click();await p.locator('.person-editor-form').waitFor();
evidence.editorTabs=[];await p.locator('.person-editor-form .name-entry input').focus();for(let i=0;i<24;i++){await p.keyboard.press('Tab');evidence.editorTabs.push(await p.evaluate(()=>{const e=document.activeElement,b=e.getBoundingClientRect();return {tag:e.tagName,text:(e.getAttribute('aria-label')||e.textContent).trim().slice(0,70),x:b.x,y:b.y,w:b.width,h:b.height,inside:!!e.closest('.inspector-dock')}}));}
await p.goto('/documents');const doc=new PDF({size:'A4'}),chunks=[];doc.on('data',x=>chunks.push(x));const done=new Promise(resolve=>doc.on('end',resolve));doc.fontSize(22).text('Synthetic archive document',60,60);doc.fontSize(12).text('UI audit. Not a real personal record.',60,100);for(let i=1;i<3;i++){doc.addPage();doc.fontSize(20).text('Page '+(i+1),60,60);}doc.end();await done;
const up=await p.request.post('/api/documents',{headers:{'Content-Type':'application/pdf','X-Document-Metadata':encodeURIComponent(JSON.stringify({title:'Тестовый архивный документ',personIds:['e2e-child']}))},data:Buffer.concat(chunks)});const u=await up.json();evidence.documentUploadStatus=up.status();
await p.goto('/documents/'+u.id);const book=p.frameLocator('iframe.pdf-book-frame');await book.locator('.BRpageimage').first().waitFor({timeout:30000});await p.waitForTimeout(500);await p.screenshot({path:out+'/reader-390.png'});
await book.getByRole('button',{name:'Комментарии',exact:true}).click();await p.screenshot({path:out+'/reader-comments-390.png'});
await p.setViewportSize({width:1440,height:900});await p.waitForTimeout(250);await p.screenshot({path:out+'/reader-comments-1440.png'});
await p.goto('/documents');await p.screenshot({path:out+'/documents-filled-1440.png'});
fs.writeFileSync(out+'/details.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify({draft:evidence.draftAfter,openFocus:evidence.aiOpenFocus,modalHeader:evidence.modalHeader,resize:evidence.resizeAfter.nodes.filter(x=>x.visible).length,fresh:evidence.freshMobile.nodes.filter(x=>x.visible).length,doc:up.status()}));await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
