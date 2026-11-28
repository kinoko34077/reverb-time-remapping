import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("three-minute stereo MP3 plays through the progressive IR Spectral kernel and returns to Normal",async()=>{
  const port=18772;
  const server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.evaluateOnNewDocument(()=>{
      const create=AudioContext.prototype.createWaveShaper;
      AudioContext.prototype.createWaveShaper=function(){
        const node=create.call(this),analyser=this.createAnalyser();analyser.fftSize=2048;
        node.connect(analyser);window.__progressiveSpectralOutput=analyser;return node;
      };
    });
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto(`http://127.0.0.1:${port}/app/`))?.ok();}catch{}
      if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,"test HTTP server unavailable");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true",{timeout:30000});
    await page.evaluate(async()=>{
      const response=await fetch("/tests/fixtures/three-minute-stereo-44k.mp3");
      if(!response.ok)throw Error("synthetic MP3 fixture unavailable");
      const transfer=new DataTransfer();
      transfer.items.add(new File([await response.blob()],"three-minute-stereo-44k.mp3",{type:"audio/mpeg"}));
      const input=document.querySelector("#source-file");input.files=transfer.files;input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み: 長尺逐次再生")&&
      document.querySelector("#source").value==="file",{timeout:30000});
    const initial=await page.evaluate(()=>({duration:Number(document.querySelector("#seek").max),
      disabled:document.querySelector('[data-mode="ir-spectral"]').disabled}));
    assert.ok(initial.duration>7_800_000,JSON.stringify(initial));
    assert.equal(initial.disabled,false,JSON.stringify(initial));

    await page.click('[data-mode="ir-spectral"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="ir-spectral"]').getAttribute("aria-pressed")==="true",
      {timeout:30000}).catch(async error=>{throw Error(`${error.message}; status=${await page.$eval("#status",e=>e.textContent)}`);});
    const applied=await page.$eval("#ir-spectral-applied",element=>element.textContent);
    assert.match(applied,/exact-raw/);
    assert.match(applied,/1500\.000 ms/,applied);
    await page.$eval("#ir-spectral-length",element=>{element.value="1500";element.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#ir-spectral-applied").textContent.includes("1500.000 ms")&&
      !document.querySelector("#play").disabled,{timeout:30000});
    assert.match(await page.$eval("#ir-spectral-applied",element=>element.textContent),/1500\.000 ms/);
    await page.$eval("#seek",(element,frame)=>{element.value=String(frame);element.dispatchEvent(new Event("input"));
      element.dispatchEvent(new Event("change"));},Math.round(170*44100));
    await page.waitForFunction(()=>Number(document.querySelector("#seek").value)>7_000_000&&
      !document.querySelector("#play").disabled,{timeout:30000});
    await page.click("#play");
    await new Promise(resolve=>setTimeout(resolve,1400));
    const playback=await page.evaluate(()=>{
      const samples=new Float32Array(window.__progressiveSpectralOutput.fftSize);
      window.__progressiveSpectralOutput.getFloatTimeDomainData(samples);
      return {frame:Number(document.querySelector("#seek").value),running:!document.querySelector("#play").disabled,
        finite:samples.every(Number.isFinite),range:Math.max(...samples)-Math.min(...samples),
        mode:document.querySelector('[data-mode="ir-spectral"]').getAttribute("aria-pressed")};
    });
    assert.equal(playback.mode,"true",JSON.stringify(playback));
    assert.ok(playback.frame>7_000_000,JSON.stringify(playback));
    assert.ok(playback.finite&&playback.range>1e-5,JSON.stringify(playback));
    await page.click("#stop");
    await page.waitForFunction(()=>Number(document.querySelector("#seek").value)===0,{timeout:10000});
    await page.click('[data-mode="normal"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true",
      {timeout:30000});
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
