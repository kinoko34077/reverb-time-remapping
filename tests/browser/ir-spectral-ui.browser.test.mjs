import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("IR Spectral actual UI renders kernels in a Worker, retains output and applies latest edits",async()=>{
  const port=18771,server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.evaluateOnNewDocument(()=>{
      const create=AudioContext.prototype.createWaveShaper;
      AudioContext.prototype.createWaveShaper=function(){
        const n=create.call(this),tap=this.createAnalyser();tap.fftSize=2048;n.connect(tap);window.__spectralOutput=tap;return n;
      };
      const Native=window.Worker;window.__workerMessages=[];
      window.Worker=class extends Native{
        postMessage(message,...rest){
          window.__workerMessages.push({source:!!message.source,speed:message.settings?.speed,start:message.settings?.startFrame});
          super.postMessage(message,...rest);
        }
      };
      const render=OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering=async function(){
        const result=await render.call(this);
        if(window.__slowIR)await new Promise(r=>setTimeout(r,180));return result;
      };
    });
    let ready=false;for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/app/"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    await page.select("#source","sine");await page.select("#ir","delay");
    await page.$eval("#ir-length",el=>el.value="0.1");
    await page.click("#prepare");
    const enabled=()=>page.waitForFunction(()=>!document.querySelector("#play").disabled);
    await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true"&&!document.querySelector("#play").disabled);
    await page.click('[data-mode="ir-spectral"]');await enabled();
    await page.select("#solo","wet");await enabled();
    assert.match(await page.$eval("#ir-spectral-applied",el=>el.textContent),/exact-raw/);
    await page.$eval("#seek",el=>{el.value="16000";el.dispatchEvent(new Event("input"));el.dispatchEvent(new Event("change"));});await enabled();
    await page.click("#play");await enabled();
    const audible=()=>page.waitForFunction(()=>{
      const a=new Float32Array(window.__spectralOutput.fftSize);window.__spectralOutput.getFloatTimeDomainData(a);
      return a.every(v=>Number.isFinite(v)&&Math.abs(v)<=.90001)&&Math.max(...a)-Math.min(...a)>.01;
    });
    await audible();
    const before=await page.$eval("#seek",el=>Number(el.value));
    await page.evaluate(()=>{
      window.__slowIR=true;
      const speed=document.querySelector("#ir-spectral-speed");speed.value="0";speed.dispatchEvent(new Event("change"));
      const slider=document.querySelector("#ir-spectral-scrub");
      slider.value="15";slider.dispatchEvent(new Event("input"));
      slider.value="2";slider.dispatchEvent(new Event("input"));
    });
    await new Promise(r=>setTimeout(r,90));await audible();
    assert.match(await page.$eval("#ir-spectral-applied",el=>el.textContent),/exact-raw/);
    assert.ok(await page.$eval("#seek",el=>Number(el.value))>before);
    await page.waitForFunction(()=>document.querySelector("#ir-spectral-applied").textContent.includes("2.000 ms / 0×")&&!document.querySelector("#play").disabled);
    assert.match(await page.$eval("#ir-spectral-applied",el=>el.textContent),/自然減衰/);
    await page.evaluate(()=>window.__slowIR=false);
    const messages=await page.evaluate(()=>window.__workerMessages);
    assert.ok(messages.length>=2,JSON.stringify(messages));
    assert.equal(messages.filter(m=>m.source).length,1);
    assert.equal(messages.at(-1).start,96);
    await page.$eval("#ir-spectral-start",el=>{el.value="200";el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("IR再合成を更新できません"));
    assert.match(await page.$eval("#ir-spectral-applied",el=>el.textContent),/2.000 ms \/ 0×/);
    await page.$eval("#ir-spectral-start",el=>{el.value="0";el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#ir-spectral-applied").textContent.includes("0.000 ms / 0×")&&!document.querySelector("#play").disabled);
    const originalMax=Number(await page.$eval("#seek",el=>el.max));
    await page.$eval("#ir-spectral-length",el=>{el.value="200";el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#ir-spectral-applied").textContent.includes("200.000 ms")&&!document.querySelector("#play").disabled);
    assert.equal(Number(await page.$eval("#seek",el=>el.max)),originalMax+4800);
    await audible();
    await page.$eval("#ir-spectral-length",el=>{el.value="100";el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#ir-spectral-applied").textContent.includes("100.000 ms")&&!document.querySelector("#play").disabled);
    assert.equal(Number(await page.$eval("#seek",el=>el.max)),originalMax+4800);
    await page.click("#pause");await enabled();
    await page.click('[data-mode="normal"]');await enabled();await page.click('[data-mode="ir-spectral"]');await enabled();
    assert.match(await page.$eval("#ir-spectral-applied",el=>el.textContent),/0.000 ms \/ 0×/);
    await page.$eval("#ir-spectral-range-end",el=>{el.value="10";el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("IR再合成を適用")&&!document.querySelector("#play").disabled);
    await page.select("#ir-spectral-boundary","pingpong");
    await page.waitForFunction(()=>document.querySelector("#ir-spectral-applied").textContent.includes("pingpong")&&!document.querySelector("#play").disabled);
    await page.$eval("#ir-spectral-speed",el=>{el.value="-1";el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#ir-spectral-applied").textContent.includes("0.000 ms / -1×")&&!document.querySelector("#play").disabled);
    assert.match(await page.$eval("#ir-spectral-applied",el=>el.textContent),/pingpong/);
    await page.$eval("#seek",el=>{el.value="16000";el.dispatchEvent(new Event("input"));el.dispatchEvent(new Event("change"));});await enabled();
    await page.click("#play");await enabled();await audible();
    await page.click("#pause");await enabled();
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
