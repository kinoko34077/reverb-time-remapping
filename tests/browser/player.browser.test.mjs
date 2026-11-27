import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";
test("regular entry prepares audio, switches comparison, seeks and retains last good WAV",async()=>{
  const port=18767,server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/app/"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    await page.select("#source","sine");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true"&&!document.querySelector("#play").disabled);
    await page.click('[data-mode="normal"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true"&&!document.querySelector("#play").disabled);
    await page.click("#play");
    await page.waitForFunction(()=>Number(document.querySelector("#status").dataset.renderedFrames)>256);
    await page.click("#pause");
    await page.waitForFunction(()=>document.querySelector("#status").textContent==="一時停止"&&!document.querySelector("#seek").disabled);
    await page.$eval("#seek",el=>{el.value="24000";el.dispatchEvent(new Event("input"));el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>!document.querySelector("#seek").disabled);
    const before=await page.$eval("#seek",el=>Number(el.value));
    await page.click('[data-mode="reverse"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="reverse"]').getAttribute("aria-pressed")==="true"&&!document.querySelector("#seek").disabled);
    assert.equal(await page.$eval("#seek",el=>Number(el.value)),before);
    await page.evaluate(()=>{
      const d=new DataTransfer();d.items.add(new File(["bad"],"bad.wav",{type:"audio/wav"}));
      const input=document.querySelector("#source-file");input.files=d.files;input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("処理できません")&&!document.querySelector("#play").disabled);
    assert.equal(await page.$eval("#source",el=>el.value),"sine");
    assert.equal(await page.$eval('[data-mode="reverse"]',el=>el.getAttribute("aria-pressed")),"true");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.setViewport({width:1280,height:800});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
