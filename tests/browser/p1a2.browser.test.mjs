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
      window.__spectralGate={holding:false,held:[]};
      window.__workerMessages=[];
      window.__playGate={holding:false,held:[]};
      if(globalThis.OfflineAudioContext){
        const prototype=OfflineAudioContext.prototype,original=prototype.startRendering;
        prototype.startRendering=function(...args){
          window.__renderCount++;
          const rendered=original.apply(this,args);
          if(!window.__renderGate.holding)return rendered;
          return rendered.then(buffer=>new Promise(resolve=>window.__renderGate.releases.push(()=>resolve(buffer))));
        };
      }
      const NativeWorker=window.Worker;
      window.Worker=class extends NativeWorker{
        postMessage(message,...rest){
          window.__workerMessages.push({speed:message.settings?.speed,start:message.settings?.startFrame});
          super.postMessage(message,...rest);
        }
        set onmessage(handler){
          super.onmessage=event=>{
            if(window.__spectralGate.holding)window.__spectralGate.held.push(()=>handler(event));
            else handler(event);
          };
        }
        get onmessage(){return super.onmessage;}
      };
      const messageHandler=Object.getOwnPropertyDescriptor(MessagePort.prototype,"onmessage");
      Object.defineProperty(MessagePort.prototype,"onmessage",{
        configurable:true,
        get(){return messageHandler.get.call(this);},
        set(handler){
          if(typeof handler!=="function"){messageHandler.set.call(this,handler);return;}
          const port=this;
          messageHandler.set.call(port,event=>{
            const message=event.data||{};
            if(window.__playGate.holding&&message.type==="command-accepted"&&message.op==="play"){
              window.__playGate.held.push(()=>handler.call(port,event));return;
            }
            handler.call(port,event);
          });
        }
      });
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
  try{await page.evaluate(()=>{
    window.__renderGate.holding=false;for(const release of window.__renderGate.releases.splice(0))release();
    window.__spectralGate.holding=false;for(const release of window.__spectralGate.held.splice(0))release();
    window.__playGate.holding=false;for(const release of window.__playGate.held.splice(0))release();
  });}catch{}
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

async function selectWav(page,id,name,seconds,frequency=440){
  await page.evaluate((inputId,fileName,duration,tone)=>{
    const sampleRate=48000,count=Math.round(sampleRate*duration),buffer=new ArrayBuffer(44+count*2),view=new DataView(buffer);
    const put=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
    put(0,"RIFF");view.setUint32(4,buffer.byteLength-8,true);put(8,"WAVEfmt ");view.setUint32(16,16,true);
    view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,sampleRate,true);view.setUint32(28,sampleRate*2,true);
    view.setUint16(32,2,true);view.setUint16(34,16,true);put(36,"data");view.setUint32(40,count*2,true);
    for(let i=0;i<count;i++)view.setInt16(44+i*2,Math.round(.3*Math.sin(2*Math.PI*tone*i/sampleRate)*32767),true);
    const files=new DataTransfer();files.items.add(new File([buffer],fileName,{type:"audio/wav"}));
    const input=document.querySelector("#"+inputId);input.files=files.files;input.dispatchEvent(new Event("change",{bubbles:true}));
  },id,name,seconds,frequency);
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

test("an IR spectral edit queued during preparation applies to the new source",async()=>{
  const app=await openApp();
  try{
    const {page}=app;
    await prepare(page);
    await page.select("#solo","dry");
    await page.click('[data-mode="ir-spectral"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="ir-spectral"]').getAttribute("aria-pressed")==="true");

    await page.evaluate(()=>{window.__renderGate.holding=true;window.__spectralGate.holding=true;});
    await page.select("#source","sine");
    await page.waitForFunction(()=>window.__renderGate.releases.length>0,{timeout:30000});
    await page.$eval("#ir-spectral-speed",field=>{field.value="2";field.dispatchEvent(new Event("change",{bubbles:true}));});
    await page.evaluate(()=>{
      window.__renderGate.holding=false;
      for(const release of window.__renderGate.releases.splice(0))release();
    });
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});
    assert.equal(await page.$eval("#ir-spectral-speed",field=>field.value),"2",
      "the queued IR Spectral speed should remain visible while it is applied to the new session");
    await page.waitForFunction(()=>!document.querySelector("#play").disabled,{timeout:5000});
    await page.click("#play");
    await page.waitForFunction(()=>{
      const analyser=window.__previewOutput;if(!analyser)return false;
      const samples=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum,value)=>sum+value*value,0)/samples.length)>.05;
    },{timeout:5000});
    await page.waitForFunction(()=>window.__spectralGate.held.length>0,{timeout:30000});
    await page.evaluate(()=>{
      window.__spectralGate.holding=false;
      for(const release of window.__spectralGate.held.splice(0))release();
    });
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("IR再合成を適用"),{timeout:30000});
    await new Promise(resolve=>setTimeout(resolve,150));
    const rms=await outputRMS(page);
    assert.ok(rms>.05,`a stale IR result must not restore the old impulse source (RMS=${rms})`);
    await page.$eval("#ir-spectral-start",field=>{field.value="5";field.dispatchEvent(new Event("change",{bubbles:true}));});
    await page.waitForFunction(()=>window.__workerMessages.some(message=>message.speed===2&&message.start===240),{timeout:10000});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("IR再合成を適用"),{timeout:10000});
    assert.equal(await page.$eval("#ir-spectral-speed",field=>field.value),"2",
      "editing another IR Spectral parameter should keep the queued speed");
    assert.deepEqual(app.errors,[]);
  }finally{await closeApp(app);}
});

test("replacing a playing long source resets playback to frame zero",async()=>{
  const app=await openApp();
  try{
    const {page}=app;
    await selectWav(page,"source-file","long.wav",4);
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み")&&document.querySelector("#source").value==="file",{timeout:30000});
    await page.click('[data-mode="normal"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true");
    await page.click("#play");
    await page.waitForFunction(()=>Number(document.querySelector("#status").dataset.renderedFrames)>0);
    await page.$eval("#seek",field=>{field.value="144000";field.dispatchEvent(new Event("input"));field.dispatchEvent(new Event("change",{bubbles:true}));});
    await page.waitForFunction(()=>Number(document.querySelector("#seek").value)>140000,{timeout:5000});

    await selectWav(page,"source-file","short.wav",.1);
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み")&&
      document.querySelector("#source").value==="file"&&Number(document.querySelector("#seek").value)<8000,{timeout:30000});
    assert.deepEqual(app.errors,[]);
  }finally{await closeApp(app);}
});

test("a stale slow file decode cannot replace a newer generated source",async()=>{
  const app=await openApp();
  try{
    const {page}=app;
    await prepare(page);
    await page.evaluate(()=>{
      const prototype=OfflineAudioContext.prototype;
      prototype.decodeAudioData=function(){
        const pcm=new Float32Array(4800).fill(.1);
        return new Promise(resolve=>{window.__resolveSlowDecode=()=>resolve({numberOfChannels:1,length:pcm.length,sampleRate:48000,getChannelData:()=>pcm});});
      };
    });
    await page.evaluate(()=>{
      const file=new File([new Uint8Array([73,68,51,0])],"slow.mp3",{type:"audio/mpeg"});
      Object.defineProperty(file,"arrayBuffer",{value:()=>new Promise(resolve=>{window.__resolveSlowBytes=async()=>resolve(await Blob.prototype.arrayBuffer.call(file));})});
      const files=new DataTransfer();files.items.add(file);
      const input=document.querySelector("#source-file");input.files=files.files;input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    await page.waitForFunction(()=>typeof window.__resolveSlowBytes==="function");
    await page.select("#source","sine");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み")&&document.querySelector("#source").value==="sine",{timeout:30000});
    await page.evaluate(()=>window.__resolveSlowBytes());
    await page.waitForFunction(()=>typeof window.__resolveSlowDecode==="function");
    await page.evaluate(()=>window.__resolveSlowDecode());
    await new Promise(resolve=>setTimeout(resolve,150));
    assert.equal(await page.$eval("#source",field=>field.value),"sine");
    assert.ok(await page.$eval("#status",element=>element.textContent.startsWith("準備済み")));
    assert.deepEqual(app.errors,[]);
  }finally{await closeApp(app);}
});

test("Stop during a mode switch keeps the installed playback mode synchronized",async()=>{
  const app=await openApp();
  try{
    const {page}=app;
    await prepare(page);
    await page.click("#play");
    await page.waitForFunction(()=>Number(document.querySelector("#status").dataset.renderedFrames)>0);
    await page.evaluate(()=>{window.__playGate.holding=true;});
    await page.click('[data-mode="wet-buffer"]');
    await page.waitForFunction(()=>window.__playGate.held.length>0,{timeout:10000});
    await page.click("#stop");
    await page.waitForFunction(()=>document.querySelector("#status").textContent==="先頭"&&
      document.querySelector("#stop").disabled===false,{timeout:5000});
    await page.evaluate(()=>{
      window.__playGate.holding=false;
      for(const release of window.__playGate.held.splice(0))release();
    });
    await page.waitForFunction(()=>!document.querySelector('[data-mode="wet-buffer"]').disabled,{timeout:5000});
    assert.equal(await page.$eval('[data-mode="wet-buffer"]',button=>button.getAttribute("aria-pressed")),"true");
    assert.equal(await page.$eval("#scrub-axes",element=>element.hidden),false);
    assert.deepEqual(app.errors,[]);
  }finally{await closeApp(app);}
});
