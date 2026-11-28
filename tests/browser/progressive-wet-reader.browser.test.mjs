import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";
import {referenceConvolution} from "../helpers/time-reference.mjs";

test("progressive Wet reader matches convolution while retaining a bounded PCM cache",async()=>{
  const port=18773;
  const server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio"]});
    const page=await browser.newPage();let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto(`http://127.0.0.1:${port}/tests/browser/blank.html`))?.ok();}catch{}
      if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,"test HTTP server unavailable");
    const result=await page.evaluate(async()=>{
      const {createProgressiveWetPCMReader}=await import("/src/progressive-wet-reader.mjs");
      const sampleRate=48000,input=Float32Array.from({length:512},(_,i)=>i%71===0?Math.sin(i):0);
      const ir=Float32Array.from({length:41},(_,i)=>Math.exp(-i/10)*Math.cos(i*.31));
      const source={sourceFrames:input.length,channelCount:1,sampleRate,windowFrames:64,maxReadFrames:64,
        async read(startFrame,frameCount){return {startFrame,channels:[input.slice(startFrame,startFrame+frameCount)]};}};
      const reader=await createProgressiveWetPCMReader(source,{origin:0,sampleRate,channels:[ir]},
        {windowFrames:64,maxCachedWindows:2,maxReadFrames:256});
      const a=await reader.read(0,64),b=await reader.read(64,64),c=await reader.read(320,64);
      const delayed=await createProgressiveWetPCMReader(source,{origin:0,sampleRate,channels:[ir]},
        {predelaySeconds:.002,windowFrames:64,maxCachedWindows:2,maxReadFrames:256});
      const d=await delayed.read(64,64);
      return {sampleRate,a:Array.from(a.channels[0]),b:Array.from(b.channels[0]),c:Array.from(c.channels[0]),
        d:Array.from(d.channels[0]),stats:reader.stats(),delayedStats:delayed.stats(),channels:reader.channelCount};
    });
    const reference=referenceConvolution(Float32Array.from({length:512},(_,i)=>i%71===0?Math.sin(i):0),
      Float32Array.from({length:41},(_,i)=>Math.exp(-i/10)*Math.cos(i*.31)));
    for(const [start,actual] of [[0,result.a],[64,result.b],[320,result.c]])
      for(let i=0;i<actual.length;i++)assert.ok(Math.abs(actual[i]-reference.samples[start+i])<2e-4,
        `sample ${start+i}: ${actual[i]} != ${reference.samples[start+i]}`);
    const delayedKernel=Float32Array.from([...new Float32Array(96),...Float32Array.from({length:41},(_,i)=>
      Math.exp(-i/10)*Math.cos(i*.31))]);
    const delayedReference=referenceConvolution(Float32Array.from({length:512},(_,i)=>i%71===0?Math.sin(i):0),delayedKernel);
    for(let i=0;i<result.d.length;i++)assert.ok(Math.abs(result.d[i]-delayedReference.samples[64+i])<2e-4,
      `predelayed sample ${64+i}: ${result.d[i]} != ${delayedReference.samples[64+i]}`);
    assert.equal(result.channels,1);
    assert.ok(result.stats.residentFrames<=128,JSON.stringify(result.stats));
    assert.ok(result.stats.residentWindows<=2,JSON.stringify(result.stats));
    assert.ok(result.delayedStats.residentFrames<=128,JSON.stringify(result.delayedStats));
  }finally{await cleanupTestProcesses(browser,[server]);}
});
