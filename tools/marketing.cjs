/* Render the shipped popup with deterministic browser API fixtures, not live-site captures.
 * Development-only dependencies: playwright, sharp. Set NODE_PATH if installed elsewhere.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const sharp = require('sharp');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'marketing');
const write = (p, data) => { fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p,data); };
async function main() {
  for (const dir of ['icons','screenshots','promotional','source']) fs.mkdirSync(path.join(out,dir),{recursive:true});
  const icon = fs.readFileSync(path.join(root,'icons/on.svg'));
  write(path.join(out,'source/feedblocker-icon.svg'),icon);
  for (const size of [32,64,128,256,512]) await sharp(icon).resize(size,size).png().toFile(path.join(out,`icons/feedblocker-icon-${size}.png`));
  const server = http.createServer((req,res)=>{
    if(req.url==='/favicon.ico'){res.writeHead(204);return res.end();}
    const file = path.resolve(root,'.'+decodeURIComponent(req.url.split('?')[0]));
    if (!file.startsWith(root+path.sep)) {res.writeHead(403);return res.end();}
    try {res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'text/html');res.end(fs.readFileSync(file));}
    catch {res.writeHead(404);res.end();}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  let browser;
  try {
    browser = await chromium.launch({channel:'msedge',headless:true});
    for (const [name,site,theme,expanded] of [
      ['01-youtube-light','youtube','light',false],
      ['02-youtube-options-dark','youtube','dark',true],
      ['03-reddit-light','reddit','light',false],
      ['04-linkedin-beta-dark','linkedin','dark',false]
    ]) {
      const context = await browser.newContext({viewport:{width:340,height:600},deviceScaleFactor:2,colorScheme:theme});
      await context.addInitScript(({base,site})=>{
        const settings={version:1,pauseUntil:0,sites:{youtube:{enabled:true,elements:{}},reddit:{enabled:true,elements:{}},linkedin:{enabled:true,elements:{}}}};
        globalThis.browser={
          runtime:{getURL:p=>base+p,getManifest:()=>({version:'1.0.0'}),sendMessage:async()=>({settings})},
          tabs:{query:async()=>[{id:1,url:`https://www.${site}.com/`}],create:async()=>{}},
          permissions:{contains:async()=>true,request:async()=>true,onRemoved:{addListener:()=>{}}}
        };
      },{base,site});
      const page=await context.newPage();
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      page.on('console',m=>{if(m.type()==='error') errors.push(m.text());});
      await page.goto(base+'popup/popup.html');
      await page.locator('#master-wrap').waitFor({state:'visible'});
      if(expanded) await page.getByRole('button',{name:'Show Shorts options',exact:true}).click();
      await page.evaluate(()=>document.fonts.ready);
      if(errors.length) throw new Error(errors.join('\n'));
      const height=await page.evaluate(()=>Math.min(600,document.body.scrollHeight));
      await page.setViewportSize({width:340,height});
      await page.mouse.move(0,0);
      const shot=await page.screenshot({fullPage:true});
      write(path.join(out,`source/feedblocker-${name}-popup.png`),shot);
      // Preserve the actual UI; only resize the capture and place on a flat canvas.
      const scaled=await sharp(shot).resize({width:374,height:704,fit:'inside'}).png().toBuffer();
      const meta=await sharp(scaled).metadata();
      await sharp({create:{width:1280,height:800,channels:3,background:theme==='dark'?'#15141a':'#f0f0f4'}})
        .composite([{input:scaled,left:Math.floor((1280-meta.width)/2),top:Math.floor((800-meta.height)/2)}]).png()
        .toFile(path.join(out,`screenshots/feedblocker-${name}-1280x800.png`));
      await context.close();
    }
    for(const [name,width,height,dark] of [['social',1200,630,false],['banner',1600,900,true]]){
      const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});
      const img=fs.readFileSync(path.join(out,'source/feedblocker-01-youtube-light-popup.png')).toString('base64');
      const html=`<!doctype html><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:${dark?'#15141a':'#fbfbfe'};color:${dark?'#fbfbfe':'#15141a'};font-family:Segoe UI,Arial,sans-serif}.layout{height:100vh;display:grid;grid-template-columns:1.3fr 1fr;gap:70px;padding:${dark?'100px':'56px'};align-items:center}.brand{display:flex;align-items:center;gap:16px;font-size:26px;font-weight:600}.brand img{width:44px;height:44px}h1{font-size:${dark?'76px':'56px'};line-height:1.06;letter-spacing:-2px;font-weight:600;margin:44px 0 24px}p{font-size:21px;line-height:1.6;color:${dark?'#bfbfc9':'#5b5b66'};max-width:510px}.rule{width:48px;height:4px;background:${dark?'#80ebff':'#0060df'};margin:30px 0}.sites{font-size:16px;line-height:1.9}.panel{justify-self:center;height:${dark?'660px':'518px'};max-width:100%;object-fit:contain;object-position:top;border:1px solid ${dark?'#3f3f46':'#e4e4ea'}}</style><div class="layout"><div><div class="brand"><img src="data:image/svg+xml;base64,${icon.toString('base64')}">FeedBlocker</div><h1>Choose what<br>stays visible.</h1><p>Hide feeds, recommendations<br>and short-form video sections.</p><div class="rule"></div><div class="sites">YouTube · Reddit · X<br>Facebook · Instagram · LinkedIn</div><p style="font-size:15px;margin-top:26px">For Firefox · Open source · No analytics</p></div><img class="panel" src="data:image/png;base64,${img}"></div>`;
      write(path.join(out,`source/feedblocker-${name}.html`),html);
      await page.setContent(html);await page.evaluate(()=>document.fonts.ready);
      await page.screenshot({path:path.join(out,`promotional/feedblocker-${name}-${width}x${height}.png`)});
      await page.close();
    }
  } finally { if(browser) await browser.close(); await new Promise(r=>server.close(r)); }
  console.log('Created 5 icons, 4 UI screenshots and 2 promotional images.');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
