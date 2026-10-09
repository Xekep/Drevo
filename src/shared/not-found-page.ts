/** Static content only: no requested URL or account information is interpolated. */
export const notFoundContent = `<div class="lost-page-content">
  <a class="lost-page-brand" href="/" aria-label="Drevo — на главную">drevo<span aria-hidden="true">.</span></a>
  <div class="lost-page-mark" aria-hidden="true">404<svg viewBox="0 0 80 100" fill="none"><path d="M40 94V43M40 67C12 65 10 40 13 27c23 1 29 16 27 40ZM40 49C40 23 55 11 70 9c5 23-7 37-30 40Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></div>
  <h1>Здесь пока нет ветви</h1>
  <p>Страница не найдена. Возможно, ссылка изменилась<br class="lost-page-break"> или в адресе опечатка.</p>
  <a class="lost-page-home" href="/">На главную <span aria-hidden="true">↗</span></a>
</div>`;

export const notFoundStyles = `
.lost-page{box-sizing:border-box;min-height:100svh;display:grid;place-items:center;padding:32px 20px;background:#fafbf8;color:#294535;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
.lost-page-content{width:min(100%,440px);text-align:center}
.lost-page-brand{display:inline-block;color:inherit;text-decoration:none;font-family:Georgia,serif;font-size:29px;letter-spacing:-1px}.lost-page-brand span{color:#819978}
.lost-page-mark{position:relative;margin:52px auto 12px;font:400 clamp(100px,22vw,148px)/1 Georgia,serif;letter-spacing:-8px;color:#e1e8dd;user-select:none}
.lost-page-mark svg{position:absolute;width:64px;height:80px;left:calc(50% - 29px);top:38px;color:#547348;transform:rotate(12deg)}
.lost-page h1{margin:24px 0 12px;font:400 clamp(24px,6vw,30px)/1.25 Georgia,serif;letter-spacing:-.5px}
.lost-page p{margin:0;color:#627360;font-size:14px;line-height:1.75}
.lost-page-home{display:inline-flex;align-items:center;gap:26px;margin-top:28px;padding:12px 20px;border-radius:24px;background:#355b43;color:white;text-decoration:none;font-size:14px;min-height:20px}
.lost-page a:focus-visible{outline:3px solid #819978;outline-offset:5px}.lost-page-home:hover{background:#294b35}
@media(max-width:360px){.lost-page-break{display:none}.lost-page-mark{margin-top:36px}}
`;

export const notFoundHtml = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Страница не найдена · Drevo</title><link rel="icon" href="/favicon.svg"><style>body{margin:0}${notFoundStyles}</style></head><body><main class="lost-page">${notFoundContent}</main></body></html>`;
