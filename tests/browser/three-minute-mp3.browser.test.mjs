import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("three-minute stereo MP3 remains seekable, restores Normal from unsupported mode, and plays",async()=>{
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
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});
    await page.click('[data-mode="reverse"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="reverse"]').getAttribute("aria-pressed")==="true");
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
      normalSelected:document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true",
      duration:document.querySelector("#source-wave-note").textContent,
      status:document.querySelector("#status").textContent
    }));
    assert.ok(loaded.seekMax>7_800_000,JSON.stringify(loaded));
    assert.equal(loaded.waveMax,loaded.seekMax-1,JSON.stringify(loaded));
    assert.equal(loaded.normalDisabled,false,JSON.stringify(loaded));
    assert.equal(loaded.irWindowDisabled,false,JSON.stringify(loaded));
    assert.equal(loaded.normalSelected,true,JSON.stringify(loaded));
    assert.ok(loaded.status.includes("reverseが未対応のためNormalへ切替"),JSON.stringify(loaded));

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
    assert.equal(await page.$eval('[data-mode="wet-buffer"]',button=>button.disabled),false);
    await page.click('[data-mode="wet-buffer"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="wet-buffer"]').getAttribute("aria-pressed")==="true",
      {timeout:30000}).catch(async error=>{throw Error(`${error.message}; status=${await page.$eval("#status",e=>e.textContent)}`);});
    assert.equal(await page.$eval("#wet-calibration",element=>element.disabled),true);
    assert.equal(await page.$eval("#wet-loop-style",element=>element.disabled),true);
    const axisBounds=await page.evaluate(()=>({sourceMax:Number(document.querySelector("#source-seek").max),
      wetMax:Number(document.querySelector("#wet-seek").max)}));
    assert.ok(axisBounds.wetMax>axisBounds.sourceMax,JSON.stringify(axisBounds));
    await page.$eval("#source-seek",(element,frame)=>{element.value=String(frame);element.dispatchEvent(new Event("change"));},
      Math.round(150*44100));
    await page.waitForFunction(()=>document.querySelector("#source-position").textContent.includes("150."),{timeout:30000});
    await page.$eval("#wet-seek",(element,frame)=>{element.value=String(frame);element.dispatchEvent(new Event("input"));
      element.dispatchEvent(new Event("change"));},Math.round(176*44100));
    await page.waitForFunction(()=>document.querySelector("#wet-position").textContent.includes("176."),{timeout:30000});
    await page.waitForFunction(()=>!document.querySelector("#play").disabled,{timeout:30000});
    await page.click("#play");
    await page.waitForFunction(()=>document.querySelector("#status").textContent==="再生要求を受理"||
      document.querySelector("#status").textContent.startsWith("再生エラー"),{timeout:30000});
    await new Promise(resolve=>setTimeout(resolve,1800));
    const beforeReverse=await page.evaluate(()=>({source:Number(document.querySelector("#source-seek").value),
      wet:Number(document.querySelector("#wet-seek").value),status:document.querySelector("#status").textContent}));
    assert.ok(beforeReverse.source>Math.round(150*44100),JSON.stringify(beforeReverse));
    await page.waitForFunction(()=>!document.querySelector("#wet-speed").disabled,{timeout:30000});
    await page.$eval("#wet-speed",element=>{element.value="-1";element.dispatchEvent(new Event("change"));});
    await new Promise(resolve=>setTimeout(resolve,1500));
    const afterReverse=await page.evaluate(()=>({source:Number(document.querySelector("#source-seek").value),
      wet:Number(document.querySelector("#wet-seek").value),status:document.querySelector("#status").textContent}));
    assert.ok(afterReverse.source>beforeReverse.source,JSON.stringify({beforeReverse,afterReverse}));
    assert.ok(afterReverse.wet<beforeReverse.wet,JSON.stringify({beforeReverse,afterReverse}));
    await page.waitForFunction(()=>!document.querySelector("#wet-speed").disabled,{timeout:30000});
    await page.$eval("#wet-speed",element=>{element.value="0";element.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>!document.querySelector("#wet-speed").disabled,{timeout:30000});
    await new Promise(resolve=>setTimeout(resolve,400));
    const freezeAnchor=await page.$eval("#wet-seek",element=>Number(element.value));
    await new Promise(resolve=>setTimeout(resolve,600));
    const frozen=await page.evaluate(()=>({source:Number(document.querySelector("#source-seek").value),
      wet:Number(document.querySelector("#wet-seek").value),speed:document.querySelector("#wet-speed").value,
      status:document.querySelector("#status").textContent}));
    assert.ok(frozen.source>afterReverse.source,JSON.stringify({afterReverse,frozen}));
    assert.equal(frozen.wet,freezeAnchor,JSON.stringify({freezeAnchor,frozen}));
    assert.deepEqual(errors,[]);
    await page.waitForFunction(()=>!document.querySelector("#wet-speed").disabled,{timeout:30000});
    await page.$eval("#wet-speed",element=>{element.value="1";element.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>!document.querySelector("#wet-speed").disabled,{timeout:30000});
    const tailStart=Math.round(180.2*44100);
    await page.waitForFunction(()=>!document.querySelector("#source-seek").disabled&&
      !document.querySelector("#wet-seek").disabled,{timeout:30000});
    await page.$eval("#source-seek",(element,frame)=>{element.value=String(frame);element.dispatchEvent(new Event("change"));},
      Math.round(179.6*44100));
    await page.waitForFunction(()=>Number(document.querySelector("#source-seek").value)>Math.round(179.5*44100),
      {timeout:30000});
    await page.waitForFunction(()=>!document.querySelector("#wet-seek").disabled,{timeout:30000});
    await page.$eval("#wet-seek",(element,frame)=>{element.value=String(frame);element.dispatchEvent(new Event("input"));
      element.dispatchEvent(new Event("change"));},tailStart);
    await page.waitForFunction(frame=>Number(document.querySelector("#wet-seek").value)===frame,
      {timeout:30000},tailStart).catch(async()=>{throw Error(JSON.stringify(await page.evaluate(()=>({wet:Number(document.querySelector("#wet-seek").value),
        max:Number(document.querySelector("#wet-seek").max),position:document.querySelector("#wet-position").textContent,
        status:document.querySelector("#status").textContent}))));});
    await page.click("#play");
    await page.waitForFunction(()=>document.querySelector("#status").textContent==="再生要求を受理"||
      document.querySelector("#status").textContent.startsWith("再生エラー"),{timeout:30000});
    await new Promise(resolve=>setTimeout(resolve,900));
    const tailPlayback=await page.evaluate(()=>({source:Number(document.querySelector("#source-seek").value),
      wet:Number(document.querySelector("#wet-seek").value),wetMax:Number(document.querySelector("#wet-seek").max),
      status:document.querySelector("#status").textContent}));
    assert.ok(tailPlayback.source>=axisBounds.sourceMax-5000,JSON.stringify({axisBounds,tailPlayback}));
    assert.ok(tailPlayback.wet>tailStart+25_000&&tailPlayback.wet<tailPlayback.wetMax,
      JSON.stringify({axisBounds,tailStart,tailPlayback}));
    await page.click("#stop");
    await page.waitForFunction(()=>Number(document.querySelector("#source-seek").value)===0,{timeout:10000});

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
    await page.$eval("#predelay",element=>{element.value="-10";element.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み:")&&
      document.querySelector("#status").textContent.includes("負Predelay"),{timeout:30000});
    assert.equal(await page.$eval('[data-mode="dry"]',button=>button.getAttribute("aria-pressed")),"true");
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
