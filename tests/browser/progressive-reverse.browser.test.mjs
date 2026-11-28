import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("three-minute stereo MP3 plays full-length progressive Reverse",async()=>{
  const port=18770;
  const python=process.env.PYTHON_BIN||(process.platform==="win32"?
    "C:\\Users\\kinok\\AppData\\Local\\Programs\\Python\\Python310\\python.exe":"python3");
  const chrome=process.env.CHROME_BIN||(process.platform==="win32"?
    "C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe":"/usr/bin/google-chrome");
  const server=spawn(python,["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:chrome,headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];
    await page.setViewport({width:390,height:844,deviceScaleFactor:1,isMobile:true,hasTouch:true});
    page.on("pageerror",error=>errors.push(error.message));
    let response;
    for(let attempt=0;attempt<30;attempt++){
      try{response=await page.goto(`http://127.0.0.1:${port}/app/`);if(response?.ok())break;}catch{}
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.equal(response?.status(),200,"app test server unavailable");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み:"),{timeout:15000});
    await page.click('[data-mode="reverse"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="reverse"]').getAttribute("aria-pressed")==="true");
    await page.evaluate(async()=>{
      const response=await fetch("/tests/fixtures/three-minute-stereo-44k.mp3");
      if(!response.ok)throw Error("synthetic MP3 fixture unavailable");
      const transfer=new DataTransfer();
      transfer.items.add(new File([await response.blob()],"three-minute-stereo-44k.mp3",{type:"audio/mpeg"}));
      const input=document.querySelector("#source-file");input.files=transfer.files;
      input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>document.querySelector("#source").value==="file"||
      document.querySelector("#status").textContent.includes("読み込めません"),{timeout:30000});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み:"),{timeout:30000});
    const loaded=await page.evaluate(()=>({max:Number(document.querySelector("#seek").max),
      reverseDisabled:document.querySelector('[data-mode="reverse"]').disabled,
      reverseSelected:document.querySelector('[data-mode="reverse"]').getAttribute("aria-pressed")==="true",
      status:document.querySelector("#status").textContent}));
    assert.ok(loaded.max>7_800_000&&loaded.reverseDisabled===false&&loaded.reverseSelected,JSON.stringify(loaded));
    const target=Math.round(176*44100+1.5*44100);
    await page.$eval("#seek",(element,frame)=>{element.value=String(frame);element.dispatchEvent(new Event("input"));
      element.dispatchEvent(new Event("change"));},target);
    await page.waitForFunction(frame=>Number(document.querySelector("#seek").value)===frame,{timeout:10000},target);
    await page.waitForFunction(()=>!document.querySelector("#play").disabled,{timeout:30000});
    await page.click("#play");
    await page.waitForFunction(()=>document.querySelector("#status").textContent==="再生要求を受理"||
      document.querySelector("#status").textContent.startsWith("再生エラー"),{timeout:30000}).catch(async error=>{
      throw Error(`${error.message}; state=${JSON.stringify(await page.evaluate(()=>({status:document.querySelector("#status").textContent,
        playDisabled:document.querySelector("#play").disabled,seek:Number(document.querySelector("#seek").value),
        renderedFrames:document.querySelector("#status").dataset.renderedFrames}))) }; errors=${JSON.stringify(errors)}`);
    });
    await new Promise(resolve=>setTimeout(resolve,1800));
    const playback=await page.evaluate(()=>({status:document.querySelector("#status").textContent,
      seek:Number(document.querySelector("#seek").value),renderedFrames:Number(document.querySelector("#status").dataset.renderedFrames)}));
    assert.ok(playback.renderedFrames>256&&playback.seek>target,JSON.stringify(playback));
    await page.click("#stop");
    await page.waitForFunction(()=>Number(document.querySelector("#seek").value)===0,{timeout:10000});
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
