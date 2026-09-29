import type { Family } from "../domain/types.ts";

export type OfflineDocument = {
  id: string;
  title: string;
  file: string;
  createdAt: string;
  personIds: string[];
};

/** One self-contained page works from file:// without a server or network request. */
export function offlineReaderHtml(
  family: Family,
  documents: OfflineDocument[],
) {
  const payload = JSON.stringify({ family, documents }).replaceAll(
    "<",
    "\\u003c",
  );
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Семейный архив · Drevo</title>
<style>
:root{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#26382b;background:#f5f7f2;font-synthesis:none}
*{box-sizing:border-box}body{margin:0}button,input{font:inherit}button{cursor:pointer}
button:focus-visible,input:focus-visible,a:focus-visible{outline:3px solid #498659;outline-offset:2px}
header{padding:24px max(24px,calc((100vw - 1200px)/2));background:#e9f0e6;border-bottom:1px solid #cddac9}
h1{font-size:clamp(1.4rem,3vw,2rem);margin:0 0 6px}header p{margin:0;color:#526656}
.tabs{display:flex;gap:8px;flex-wrap:wrap;margin-top:22px}.tabs button{border:1px solid #bed0b9;background:#fff;color:#31533a;border-radius:999px;padding:9px 16px}
.tabs button[aria-current=page]{background:#315e3d;color:#fff}
main{max-width:1200px;margin:auto;padding:24px;display:grid;grid-template-columns:minmax(260px,350px) minmax(0,1fr);gap:20px}
.panel{background:#fff;border:1px solid #dce5d8;border-radius:16px;box-shadow:0 8px 28px #203d2610;min-width:0}.index{padding:16px;align-self:start;max-height:calc(100vh - 220px);overflow:auto}.detail{padding:24px;min-height:300px}
label{display:block;font-size:.88rem;color:#536558;margin-bottom:8px}.search{width:100%;padding:11px 13px;border:1px solid #c7d4c3;border-radius:10px;background:#fff}
.summary{color:#647267;font-size:.85rem;margin:12px 0}.list{display:grid;gap:6px}.list button{width:100%;text-align:left;border:0;border-radius:9px;background:#f4f7f2;color:#253d2b;padding:11px 12px}.list button:hover,.list button[aria-current=true]{background:#e1eddd}
.pager{display:flex;gap:8px;margin-top:14px}.pager button,.relative{border:1px solid #c4d4bf;border-radius:8px;background:#fff;color:#315a3b;padding:7px 10px}.pager button:disabled{opacity:.45;cursor:default}
h2{font-size:1.45rem;margin:0 0 12px}h3{font-size:1rem;color:#356344;margin:22px 0 8px}.muted{color:#6c786d}.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;margin:16px 0}.fact{background:#f5f8f3;padding:12px;border-radius:10px}.fact small{display:block;color:#647467;margin-bottom:4px}
.portrait{width:96px;height:96px;object-fit:cover;border-radius:50%;float:right;margin:0 0 12px 18px}.relations{display:flex;flex-wrap:wrap;gap:7px}.event,.source{border-left:2px solid #c5d9c3;padding:5px 0 5px 12px;margin:9px 0;white-space:pre-wrap;overflow-wrap:anywhere}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(145px,1fr));gap:12px}.gallery button{border:1px solid #d8e3d4;background:#fff;border-radius:12px;padding:8px;text-align:left;color:inherit}.gallery img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px}.gallery span{display:block;margin-top:6px}.large-photo{max-width:100%;max-height:65vh;object-fit:contain;border-radius:10px}.document-link{display:inline-block;padding:10px 14px;border-radius:9px;background:#315e3d;color:#fff;text-decoration:none;margin-top:12px}
footer{max-width:1200px;margin:16px auto 32px;padding:0 24px;color:#68766a;font-size:.85rem}
@media(max-width:700px){main{display:block;padding:14px}.index{max-height:36vh;margin-bottom:12px}.detail{padding:18px}.facts{grid-template-columns:1fr}header{padding:18px}}
</style></head><body>
<header><h1 id="archive-title"></h1><p>Переносимая копия семейного архива · работает без интернета</p><nav class="tabs" aria-label="Разделы архива"></nav></header>
<main><aside class="panel index"><label for="search">Поиск в разделе</label><input id="search" class="search" type="search" autocomplete="off"><div class="summary" id="summary"></div><div class="list" id="list"></div><div class="pager" id="pager"></div></aside><article class="panel detail" id="detail" aria-live="polite"></article></main>
<footer>Данные скопированы из Drevo. Офлайн-копия не обновляется автоматически и может содержать личные сведения: передавайте её только тем, кому доверяете.</footer>
<script type="application/json" id="archive-data">${payload}</script>
<script>
"use strict";
const data=JSON.parse(document.getElementById("archive-data").textContent), family=data.family, people=family.people, peopleById=new Map(people.map(p=>[p.id,p]));
const tabs=[["people","Люди"],["photos","Фото"],["documents","Документы"],["places","Места"]];
const nav=document.querySelector(".tabs"),list=document.getElementById("list"),detail=document.getElementById("detail"),search=document.getElementById("search"),summary=document.getElementById("summary"),pager=document.getElementById("pager");
let active="people",page=0,selected=null;
const name=p=>[p.surname,p.name,p.patronymic].filter(Boolean).join(" ")||"Имя не указано";
const el=(tag,text,cls)=>{const item=document.createElement(tag);if(text!==undefined)item.textContent=String(text);if(cls)item.className=cls;return item};
const clear=node=>node.replaceChildren();
const safeFile=value=>typeof value==="string"&&new RegExp("^media/[a-f0-9-]{36}[.](?:jpg|png|webp|gif|pdf)$").test(value)?value:null;
const showPerson=id=>{active="people";selected=id;page=0;search.value="";render()};
const heading=(text,parent=detail)=>parent.append(el("h3",text));
const relation=(label,ids)=>{const entries=[...new Set(ids)].filter(id=>peopleById.has(id));if(!entries.length)return;heading(label);const wrap=el("div",undefined,"relations");for(const id of entries){const button=el("button",name(peopleById.get(id)),"relative");button.type="button";button.onclick=()=>showPerson(id);wrap.append(button)}detail.append(wrap)};
const source=(item,parent=detail)=>{const line=el("div",[item.title,item.reference,item.url,item.note].filter(Boolean).join(" · "),"source");parent.append(line)};
const places=()=>{const counts=new Map();const add=(place,id)=>{if(!place)return;const key=place.trim();if(!key)return;const row=counts.get(key)||{title:key,ids:new Set()};if(id)row.ids.add(id);counts.set(key,row)};for(const p of people){add(p.birthPlace,p.id);add(p.deathPlace,p.id);for(const event of p.events||[])add(event.place,p.id)}for(const photo of family.photos||[])add(photo.place,null);return [...counts.values()].sort((a,b)=>a.title.localeCompare(b.title,"ru"))};
const items=()=>active==="people"?people.map(p=>({id:p.id,title:name(p),value:p})):active==="photos"?(family.photos||[]).map(p=>({id:p.id,title:p.title,value:p})):active==="documents"?data.documents.map(p=>({id:p.id,title:p.title,value:p})):places().map(p=>({id:p.title,title:p.title,value:p}));
function renderDetail(item){clear(detail);if(!item){detail.append(el("p","Выберите запись слева.","muted"));return}const p=item.value;if(active==="people"){
if(safeFile(p.photo)){const img=el("img",undefined,"portrait");img.src=p.photo;img.alt="Портрет: "+name(p);detail.append(img)}detail.append(el("h2",name(p)));if(p.maidenName)detail.append(el("p","Фамилия при рождении: "+p.maidenName,"muted"));
const facts=el("div",undefined,"facts");for(const [label,value] of [["Рождение",[p.birth,p.birthPlace].filter(Boolean).join(" · ")],["Смерть",[p.death,p.deathPlace].filter(Boolean).join(" · ")],["Занятие",p.occupation]])if(value){const box=el("div",undefined,"fact");box.append(el("small",label),el("span",value));facts.append(box)}detail.append(facts);if(p.biography)detail.append(el("p",p.biography));
relation("Родители",p.parents||[]);relation("Супруги и партнёры",p.spouses||[]);relation("Дети",people.filter(x=>(x.parents||[]).includes(p.id)).map(x=>x.id));
const extra=(family.links||[]).filter(x=>x.from===p.id||x.to===p.id);if(extra.length){heading("Дополнительные связи");for(const link of extra){const other=peopleById.get(link.from===p.id?link.to:link.from);if(other){const row=el("div",[link.type,name(other),link.note].filter(Boolean).join(" · "),"event");detail.append(row)}}}
if((p.events||[]).length){heading("События");for(const event of p.events){detail.append(el("div",[event.dateText||event.date,event.title||event.type,event.place,event.description].filter(Boolean).join(" · "),"event"));for(const s of event.sources||[])source(s)}}if((p.sources||[]).length){heading("Источники");for(const s of p.sources)source(s)}
}else if(active==="photos"){detail.append(el("h2",p.title));if(safeFile(p.url)){const img=el("img",undefined,"large-photo");img.src=p.url;img.alt=p.title;detail.append(img)}detail.append(el("p",[p.takenAt||p.year,p.place,p.description].filter(Boolean).join(" · "),"muted"));relation("На снимке",(p.tags||[]).map(t=>t.personId))}
else if(active==="documents"){detail.append(el("h2",p.title));detail.append(el("p","PDF-документ · "+(p.createdAt||"Дата не указана"),"muted"));relation("Связанные люди",p.personIds||[]);if(safeFile(p.file)){const link=el("a","Открыть PDF","document-link");link.href=p.file;link.target="_blank";link.rel="noopener";detail.append(link)}}
else{detail.append(el("h2",p.title));detail.append(el("p","Упоминается у людей: "+p.ids.size,"muted"));relation("Люди",[...p.ids])}}
function render(){clear(nav);for(const [key,label] of tabs){const button=el("button",label);button.type="button";if(key===active)button.setAttribute("aria-current","page");button.onclick=()=>{active=key;selected=null;page=0;search.value="";render()};nav.append(button)}const all=items(),q=search.value.trim().toLocaleLowerCase("ru").replaceAll("ё","е"),filtered=q?all.filter(x=>x.title.toLocaleLowerCase("ru").replaceAll("ё","е").includes(q)):all;const limit=60,maxPage=Math.max(0,Math.ceil(filtered.length/limit)-1);page=Math.min(page,maxPage);if(selected===null||!filtered.some(x=>x.id===selected))selected=filtered[0]?.id||null;summary.textContent="Найдено: "+filtered.length;clear(list);for(const item of filtered.slice(page*limit,(page+1)*limit)){const button=el("button",item.title);button.type="button";if(item.id===selected)button.setAttribute("aria-current","true");button.onclick=()=>{selected=item.id;render()};list.append(button)}clear(pager);for(const [label,delta] of [["← Назад",-1],["Далее →",1]]){const button=el("button",label);button.type="button";button.disabled=page+delta<0||page+delta>maxPage;button.onclick=()=>{page+=delta;render()};pager.append(button)}renderDetail(filtered.find(x=>x.id===selected)||null)}
document.getElementById("archive-title").textContent=family.title||"Семейный архив";search.addEventListener("input",()=>{page=0;selected=null;render()});render();
</script></body></html>`;
}
