import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("real Wet Buffer/PV Worklets keep independent axes and non-DC freeze output",async()=>{
  const port=18768,server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    await page.evaluateOnNewDocument(()=>{
      const original=AudioContext.prototype.createWaveShaper;
      AudioContext.prototype.createWaveShaper=function(){
        const node=original.call(this),tap=this.createAnalyser();tap.fftSize=2048;
        node.connect(tap);window.__scrubOutput=tap;return node;
      };
    });
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/app/"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    const enabled=()=>page.waitForFunction(()=>!document.querySelector("#play").disabled);
    const choose=async mode=>{
      await page.click('[data-mode="'+mode+'"]');
      await page.waitForFunction(m=>document.querySelector('[data-mode="'+m+'"]').getAttribute("aria-pressed")==="true"&&!document.querySelector("#play").disabled,{},mode);
    };
    const field=async(id,value)=>{await page.$eval("#"+id,(el,v)=>{el.value=String(v);el.dispatchEvent(new Event("change"));},value);await enabled();};
    const pos=name=>page.$eval("#"+name+"-seek",el=>Number(el.value));
    const audible=()=>page.waitForFunction(()=>{
      const tap=window.__scrubOutput;if(!tap)return false;
      const a=new Float32Array(tap.fftSize);tap.getFloatTimeDomainData(a);
      return a.every(v=>Number.isFinite(v)&&Math.abs(v)<=.90001)&&Math.max(...a)-Math.min(...a)>.01;
    });
    await page.select("#source","sine");await page.select("#ir","delay");
    await page.$eval("#ir-length",el=>el.value="0.1");
    await page.click("#prepare");await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true"&&!document.querySelector("#play").disabled);
    await choose("wet-buffer");await page.select("#solo","wet");await enabled();
    await field("source-seek",24000);await field("wet-seek",30000);await field("wet-speed",0);
    await page.click("#play");await enabled();
    await page.waitForFunction(()=>Number(document.querySelector("#source-seek").value)>26000);
    assert.equal(await pos("wet"),30000);await audible();
    await page.click("#pause");await enabled();
    const sourceBefore=await pos("source");
    await choose("wet-spectral");assert.equal(await pos("wet"),30000);
    assert.equal(await pos("source"),sourceBefore);
    await page.click("#play");await enabled();await audible();
    assert.equal(await pos("wet"),30000);
    // Verify real frequency content, not merely selected mode metadata.
    const energy=async hz=>page.evaluate(hz=>{
      const tap=window.__scrubOutput,pcm=new Float32Array(tap.fftSize);tap.getFloatTimeDomainData(pcm);
      let r=0,j=0;for(let i=0;i<pcm.length;i++){
        const phase=2*Math.PI*hz*i/tap.context.sampleRate;
        r+=pcm[i]*Math.cos(phase);j+=pcm[i]*Math.sin(phase);
      }
      return Math.hypot(r,j);
    },hz);
    assert.ok(await energy(440)>3*await energy(880),"PV freeze retains the 440Hz carrier");
    const wetBefore=await pos("wet");await field("wet-speed",-1);
    await page.waitForFunction(p=>Number(document.querySelector("#wet-seek").value)<p-512,{},wetBefore);
    await page.click("#pause");await enabled();
    await field("wet-seek",512);
    await page.$eval("#wet-repeat",el=>{el.checked=true;el.dispatchEvent(new Event("change"));});await enabled();
    await page.click("#play");await enabled();
    await page.waitForFunction(()=>Number(document.querySelector("#wet-seek").value)>30000);
    await page.click("#pause");await enabled();
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
