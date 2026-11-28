import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("three-minute stereo MP3 remains seekable and plays with Dry and Normal in the app",async()=>{
  const port=18767;
  const server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto(`http://127.0.0.1:${port}/app/`))?.ok();}catch{}
      if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,"test HTTP server unavailable");
    await page.evaluate(async()=>{
      const response=await fetch("/tests/fixtures/three-minute-stereo-44k.mp3");
      if(!response.ok)throw Error("synthetic MP3 fixture unavailable");
      const data=new DataTransfer();
      data.items.add(new File([await response.blob()],"three-minute-stereo-44k.mp3",{type:"audio/mpeg"}));
      const input=document.querySelector("#source-file");
      input.files=data.files;input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>document.querySelector("#source").value==="file"||
      document.querySelector("#status").textContent.includes("読み込めません"),{timeout:30000});
    const importState=await page.evaluate(()=>({
      source:document.querySelector("#source").value,status:document.querySelector("#status").textContent
    }));
    assert.equal(importState.source,"file",JSON.stringify(importState));
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});
    const loaded=await page.evaluate(()=>({
      seekMax:Number(document.querySelector("#seek").max),
      waveMax:Number(document.querySelector("#wave-detail").getAttribute("aria-valuemax")),
      normalDisabled:document.querySelector('[data-mode="normal"]').disabled,
      irWindowDisabled:document.querySelector('[data-mode="ir-window"]').disabled,
      duration:document.querySelector("#source-wave-note").textContent,
      status:document.querySelector("#status").textContent
    }));
    assert.ok(loaded.seekMax>7_800_000,JSON.stringify(loaded));
    assert.equal(loaded.waveMax,loaded.seekMax-1,JSON.stringify(loaded));
    assert.equal(loaded.normalDisabled,false,JSON.stringify(loaded));
    assert.equal(loaded.irWindowDisabled,false,JSON.stringify(loaded));

    await page.click('[data-mode="ir-window"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="ir-window"]').getAttribute("aria-pressed")==="true");
    await page.$eval("#ir-window-start",element=>{
      element.value="20";element.dispatchEvent(new Event("change"));
    });
    await new Promise(resolve=>setTimeout(resolve,1500));
    const windowState=await page.evaluate(()=>({range:document.querySelector("#window-range").textContent,
      status:document.querySelector("#status").textContent}));
    assert.ok(windowState.range.includes("20.000"),JSON.stringify(windowState));

    await page.click('[data-mode="normal"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true");
    await page.$eval("#seek",(element,frame)=>{
      element.value=String(frame);element.dispatchEvent(new Event("input"));element.dispatchEvent(new Event("change"));
    },Math.round(176*44100));
    await page.waitForFunction(()=>Number(document.querySelector("#seek").value)>7_700_000);
    await page.waitForFunction(()=>!document.querySelector("#play").disabled);
    await page.click("#play");
    await new Promise(resolve=>setTimeout(resolve,2500));
    const playback=await page.evaluate(()=>({status:document.querySelector("#status").textContent,
      renderedFrames:document.querySelector("#status").dataset.renderedFrames,
      seek:document.querySelector("#seek").value}));
    assert.ok(Number(playback.renderedFrames)>256,JSON.stringify(playback));
    await page.click("#stop");
    await page.waitForFunction(()=>Number(document.querySelector("#seek").value)===0);
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
