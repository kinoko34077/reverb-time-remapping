import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("IR window endpoints are directly editable on the real IR waveform",async()=>{
  const port=18775;
  const server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",error=>errors.push(error.message));
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto(`http://127.0.0.1:${port}/app/`))?.ok();}catch{}
      if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,"test HTTP server unavailable");
    await page.select("#source","sine");await page.select("#ir","delay");
    await page.$eval("#ir-length",element=>{element.value="0.2";});
    await page.$eval("#ir-window-length",element=>{element.value="20";});
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true");
    await page.click('[data-mode="ir-window"]');
    await page.waitForFunction(()=>!document.querySelector("#play").disabled&&
      !document.querySelector("#ir-live").hidden);

    const canvas=await page.$("#ir-wave-detail");
    await canvas.evaluate(element=>element.scrollIntoView({block:"center"}));
    const box=await canvas.boundingBox();
    const marker=await page.$eval("#ir-wave-b-marker",element=>({hidden:element.hidden,
      x:element.getBoundingClientRect().x+element.getBoundingClientRect().width/2}));
    assert.equal(marker.hidden,false);
    await page.mouse.move(marker.x,box.y+box.height/2);
    await page.mouse.down();
    const down=await page.$eval("#ir-wave-detail-wrap",element=>element.dataset.interaction);
    await page.mouse.move(box.x+box.width*.8,box.y+box.height/2,{steps:6});
    const moving=await page.$eval("#ir-window-length",element=>element.value);
    await page.mouse.up();

    const afterDrag=await page.evaluate(()=>({
      length:Number(document.querySelector("#ir-window-length").value),
      start:Number(document.querySelector("#ir-window-start").value),
      active:document.querySelector("#ir-wave-detail-wrap").dataset.active,
      markerA:document.querySelector("#ir-wave-a-marker").getBoundingClientRect().x,
      markerB:document.querySelector("#ir-wave-b-marker").getBoundingClientRect().x,
      status:document.querySelector("#status").textContent
    }));
    assert.equal(down,"b",JSON.stringify(afterDrag));
    assert.ok(Number(moving)>=20,JSON.stringify(afterDrag));
    assert.ok(afterDrag.length>50,JSON.stringify(afterDrag));
    await page.waitForFunction(()=>{
      const range=document.querySelector("#window-range").textContent.match(/適用IR窓:\s*([\d.]+)\s*–\s*([\d.]+)/);
      return !!range&&Number(range[2])>50&&!document.querySelector("#play").disabled;
    },{timeout:4000}).catch(()=>{});
    const state=await page.evaluate(()=>({
      length:Number(document.querySelector("#ir-window-length").value),
      selected:document.querySelector("#window-range").textContent,
      request:document.querySelector("#window-request").textContent,
      status:document.querySelector("#status").textContent,
      playDisabled:document.querySelector("#play").disabled,
      marker:document.querySelector("#ir-wave-b-marker").style.left,
      irSamples:Number(document.querySelector("#ir-wave-detail").getAttribute("aria-valuemax"))
    }));
    assert.ok(state.length>50&&state.length<70,JSON.stringify(state));
    const range=state.selected.match(/適用IR窓:\s*([\d.]+)\s*–\s*([\d.]+)/);
    assert.ok(range&&Math.abs(Number(range[1]))<.01&&Number(range[2])>50&&Number(range[2])<70,JSON.stringify(state));
    assert.ok(state.marker&&state.irSamples>9000,JSON.stringify(state));

    // A moves the viewport's apparent start. Repeating the same pointer
    // coordinate must not keep moving A as the editor refreshes.
    await page.$eval("#ir-window-start",element=>{element.value="40";element.dispatchEvent(new Event("change",{bubbles:true}));});
    await page.$eval("#ir-window-length",element=>{element.value="20";element.dispatchEvent(new Event("change",{bubbles:true}));});
    await page.waitForFunction(()=>document.querySelector("#window-range").textContent.includes("適用IR窓: 40.00")&&
      !document.querySelector("#play").disabled,{timeout:4000});
    const markerA=await page.$eval("#ir-wave-a-marker",element=>({hidden:element.hidden,
      x:element.getBoundingClientRect().x+element.getBoundingClientRect().width/2}));
    assert.equal(markerA.hidden,false);
    const rect=await canvas.boundingBox(),targetX=markerA.x+40,targetY=rect.y+rect.height/2;
    await page.mouse.move(markerA.x,targetY);await page.mouse.down();
    await page.mouse.move(targetX,targetY,{steps:3});
    const afterFirstMove=Number(await page.$eval("#ir-window-start",element=>element.value));
    await page.mouse.move(targetX,targetY);
    const afterStationaryMove=Number(await page.$eval("#ir-window-start",element=>element.value));
    assert.ok(Math.abs(afterStationaryMove-afterFirstMove)<0.01,
      JSON.stringify({afterFirstMove,afterStationaryMove}));
    await page.mouse.up();
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
