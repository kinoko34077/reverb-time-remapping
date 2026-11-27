import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("IR window changes keep old output while rendering and apply only the latest window",async()=>{
  const port=18769,server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.evaluateOnNewDocument(()=>{
      const create=AudioContext.prototype.createWaveShaper;
      AudioContext.prototype.createWaveShaper=function(){
        const n=create.call(this),tap=this.createAnalyser();tap.fftSize=2048;n.connect(tap);window.__irOutput=tap;return n;
      };
      const render=OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering=async function(){
        const result=await render.call(this);
        if(window.__slowIR)await new Promise(r=>setTimeout(r,180));
        return result;
      };
    });
    let ready=false;for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/app/"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    await page.select("#source","sine");await page.select("#ir","delay");
    await page.$eval("#ir-length",el=>el.value="0.1");
    await page.$eval("#ir-window-length",el=>el.value="10");
    await page.click("#prepare");
    const enabled=()=>page.waitForFunction(()=>!document.querySelector("#play").disabled);
    await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true"&&!document.querySelector("#play").disabled);
    await page.click('[data-mode="ir-window"]');await enabled();
    await page.select("#solo","wet");await enabled();
    await page.$eval("#seek",el=>{el.value="24000";el.dispatchEvent(new Event("input"));el.dispatchEvent(new Event("change"));});await enabled();
    await page.click("#play");await enabled();
    const audible=()=>page.waitForFunction(()=>{
      const a=new Float32Array(window.__irOutput.fftSize);window.__irOutput.getFloatTimeDomainData(a);
      return a.every(v=>Number.isFinite(v)&&Math.abs(v)<=.90001)&&Math.max(...a)-Math.min(...a)>.01;
    });
    await audible();
    const before=await page.$eval("#seek",el=>Number(el.value));
    await page.evaluate(()=>{
      window.__slowIR=true;
      const slider=document.querySelector("#ir-window-scrub");
      slider.value="40";slider.dispatchEvent(new Event("input"));
      slider.value="95";slider.dispatchEvent(new Event("input"));
    });
    await new Promise(r=>setTimeout(r,90));await audible();
    assert.ok((await page.$eval("#window-range",el=>el.textContent)).includes("0.000 – 10.000"));
    assert.ok(await page.$eval("#seek",el=>Number(el.value))>before);
    await page.waitForFunction(()=>document.querySelector("#window-range").textContent.includes("95.000 – 100.000")&&!document.querySelector("#play").disabled);
    await audible();
    const after=await page.$eval("#seek",el=>Number(el.value));assert.ok(after>before);
    await page.evaluate(()=>window.__slowIR=false);
    await page.select("#ir-calibration","compensated");
    await page.waitForFunction(()=>document.querySelector("#window-range").textContent.includes("RMS補正")&&!document.querySelector("#play").disabled);
    await audible();
    await page.$eval("#ir-window-start",el=>{el.value="200";el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("IR窓を更新できません"));
    assert.ok((await page.$eval("#window-range",el=>el.textContent)).includes("95.000 – 100.000"));
    await page.click("#pause");await enabled();
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
