import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("A/B selects switch the existing modes without changing comparison settings",async()=>{
  const port=18768,server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/app/"))?.ok();}catch{}
      if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready);
    await page.select("#source","sine");await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true"&&!document.querySelector("#play").disabled);
    assert.equal(await page.$eval("#ab-a-mode",element=>element.value),"dry");
    assert.equal(await page.$eval("#ab-b-mode",element=>element.value),"normal");
    assert.match(await page.$eval("#ab-state",element=>element.textContent),/A: Dry \/ B: Normal/);
    const mix=await page.$eval("#wet",element=>element.value);

    await page.click("#ab-listen-b");
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true");
    assert.equal(await page.$eval("#ab-listen-b",element=>element.getAttribute("aria-pressed")),"true");
    assert.equal(await page.$eval("#wet",element=>element.value),mix);
    assert.equal(await page.$eval("#source",element=>element.value),"sine");

    await page.focus("#ab-a-mode");await page.keyboard.press("ArrowDown");await page.keyboard.press("Enter");
    assert.equal(await page.$eval("#ab-a-mode",element=>element.value),"reverse");
    await page.focus("#ab-listen-a");await page.keyboard.press("Enter");
    await page.waitForFunction(()=>document.querySelector('[data-mode="reverse"]').getAttribute("aria-pressed")==="true");
    assert.equal(await page.$eval("#ab-listen-a",element=>element.getAttribute("aria-pressed")),"true");
    assert.equal(await page.$eval("#wet",element=>element.value),mix);
    assert.equal(await page.$eval("#source",element=>element.value),"sine");

    await page.click('[data-mode="ir-window"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="ir-window"]').getAttribute("aria-pressed")==="true");
    assert.equal(await page.$eval("#ab-listen-a",element=>element.getAttribute("aria-pressed")),"false");
    assert.equal(await page.$eval("#ab-listen-b",element=>element.getAttribute("aria-pressed")),"false");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.setViewport({width:1280,height:800});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
