import test from "node:test";
import assert from "node:assert/strict";
import {createReadStream} from "node:fs";
import {stat} from "node:fs/promises";
import {createServer} from "node:http";
import {extname,resolve,sep} from "node:path";
import {fileURLToPath} from "node:url";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

const root=resolve(fileURLToPath(new URL("../../",import.meta.url)));
const types={".html":"text/html; charset=utf-8",".css":"text/css; charset=utf-8",".js":"text/javascript; charset=utf-8",".mjs":"text/javascript; charset=utf-8",".svg":"image/svg+xml"};

async function openApp(){
  const server=createServer(async(req,res)=>{
    try{
      let pathname=decodeURIComponent(new URL(req.url,"http://localhost").pathname);
      if(pathname.endsWith("/"))pathname+="index.html";
      const path=resolve(root,"."+pathname);
      if(path!==root&&!path.startsWith(root+sep)){res.writeHead(403).end();return;}
      const info=await stat(path);
      if(!info.isFile()){res.writeHead(404).end();return;}
      res.writeHead(200,{"content-type":types[extname(path)]??"application/octet-stream"});
      createReadStream(path).pipe(res);
    }catch{res.writeHead(404).end();}
  });
  await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  let browser;
  try{
    const executablePath=process.env.CHROME_BIN??(process.platform==="win32"?
      "C:/Program Files/Google/Chrome/Application/chrome.exe":"/usr/bin/google-chrome");
    browser=await puppeteer.launch({executablePath,headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage();
    await page.evaluateOnNewDocument(()=>{
      window.__renderCount=0;
      window.__renderGate={holding:false,releases:[]};
      if(globalThis.OfflineAudioContext){
        const prototype=OfflineAudioContext.prototype,original=prototype.startRendering;
        prototype.startRendering=function(...args){
          window.__renderCount++;
          const rendered=original.apply(this,args);
          if(!window.__renderGate.holding)return rendered;
          return rendered.then(buffer=>new Promise(resolve=>window.__renderGate.releases.push(()=>resolve(buffer))));
        };
      }
      const original=AudioContext.prototype.createWaveShaper;
      AudioContext.prototype.createWaveShaper=function(...args){
        const node=original.apply(this,args),tap=this.createAnalyser();tap.fftSize=4096;
        node.connect(tap);window.__previewOutput=tap;return node;
      };
    });
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    const errors=[];page.on("pageerror",error=>errors.push(error.message));
    const address=`http://127.0.0.1:${server.address().port}/app/`;
    const response=await page.goto(address);
    assert.ok(response?.ok(),"application entry should load");
    return {browser,page,server,errors};
  }catch(error){
    await browser?.close();
    await new Promise(resolve=>server.close(resolve));
    throw error;
  }
}

async function closeApp({browser,page,server}){
  try{await page.evaluate(()=>{window.__renderGate.holding=false;for(const release of window.__renderGate.releases.splice(0))release();});}catch{}
  await cleanupTestProcesses(browser);
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
}

async function prepare(page){
  await page.click("#prepare");
  await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});
}

async function outputRMS(page){
  return page.evaluate(()=>{
    const analyser=window.__previewOutput;if(!analyser)return 0;
    const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
    return Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length);
  });
}

test("source, IR and generation edits automatically prepare a new comparison",async()=>{
  const app=await openApp();
  try{
    const {page}=app;
    await prepare(page);
    let before=await page.evaluate(()=>window.__renderCount);
    await page.select("#source","sine");
    await page.waitForFunction(n=>window.__renderCount>n,{timeout:10000},before);
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});

    before=await page.evaluate(()=>window.__renderCount);
    await page.select("#ir","delay");
    await page.waitForFunction(n=>window.__renderCount>n,{timeout:10000},before);
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});

    before=await page.evaluate(()=>window.__renderCount);
    await page.$eval("#frequency",field=>{field.value="880";field.dispatchEvent(new Event("change",{bubbles:true}));});
    await page.waitForFunction(n=>window.__renderCount>n,{timeout:10000},before);
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});
    assert.deepEqual(app.errors,[]);
  }finally{await closeApp(app);}
});

test("committed Wet edits apply during playback without recomputing convolution",async()=>{
  const app=await openApp();
  try{
    const {page}=app;
    await page.$eval("#source",field=>{field.value="sine";});
    await prepare(page);
    await page.click('[data-mode="normal"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true");
    const renders=await page.evaluate(()=>window.__renderCount);
    await page.click("#play");
    await page.waitForFunction(()=>Number(document.querySelector("#status").dataset.renderedFrames)>0);
    const before=await outputRMS(page);

    await page.focus("#wet");
    await page.keyboard.down("Control");
    await page.keyboard.press("A");
    await page.keyboard.up("Control");
    await page.keyboard.type("100");
    await page.keyboard.press("Tab");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("適用: normal / Wet 100.000%"),{timeout:10000});
    await page.waitForFunction(()=>{
      const analyser=window.__previewOutput;if(!analyser)return false;
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length)>.001;
    });
    const after=await outputRMS(page);
    assert.ok(Math.abs(after-before)>.001,`Wet change should alter preview output RMS (${before} -> ${after})`);
    assert.equal(await page.evaluate(()=>window.__renderCount),renders,"Wet changes must reuse prepared convolution signals");
    assert.deepEqual(app.errors,[]);
  }finally{await closeApp(app);}
});

test("stop remains available during preparation and stays stopped afterward",async()=>{
  const app=await openApp();
  try{
    const {page}=app;
    await page.$eval("#source",field=>{field.value="sine";});
    await prepare(page);
    await page.click("#play");
    await page.waitForFunction(async()=>{
      const analyser=window.__previewOutput;if(!analyser)return false;
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length)>.001;
    });

    await page.evaluate(()=>{window.__renderGate.holding=true;});
    await page.click("#prepare");
    await page.waitForFunction(()=>window.__renderGate.releases.length>0,{timeout:30000});
    assert.equal(await page.$eval("#source",field=>field.disabled),false,"source controls should remain editable during preparation");
    assert.ok(await outputRMS(page)>.001,"the last good preview should keep playing while preparation runs");
    assert.equal(await page.$eval("#stop",button=>button.disabled),false,"stop should remain enabled during preparation");
    await page.click("#stop");
    await page.waitForFunction(async()=>{
      const analyser=window.__previewOutput;if(!analyser)return false;
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length)<.001;
    },{timeout:5000});

    await page.evaluate(()=>{
      window.__renderGate.holding=false;
      for(const release of window.__renderGate.releases.splice(0))release();
    });
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});
    await new Promise(resolve=>setTimeout(resolve,250));
    assert.ok(await outputRMS(page)<.001,"preparation completion must not restart audio after stop");
    assert.deepEqual(app.errors,[]);
  }finally{await closeApp(app);}
});
