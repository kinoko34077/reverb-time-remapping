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
      const tail=await reader.read(512,40);
      const delayed=await createProgressiveWetPCMReader(source,{origin:0,sampleRate,channels:[ir]},
        {predelaySeconds:.002,windowFrames:64,maxCachedWindows:2,maxReadFrames:256});
      const d=await delayed.read(64,64);
      const delayedTail=await delayed.read(600,48);
      let releaseEntered,readCalls=0;const entered=new Promise(resolve=>releaseEntered=resolve),releases=[];
      const slowSource={sourceFrames:256,channelCount:1,sampleRate,windowFrames:64,maxReadFrames:64,
        async read(startFrame,frameCount){
          readCalls++;if(readCalls===2)releaseEntered();
          await new Promise(resolve=>releases.push(resolve));
          return {startFrame,channels:[new Float32Array(frameCount)]};
        }};
      const cancellable=await createProgressiveWetPCMReader(slowSource,{origin:0,sampleRate,channels:[Float32Array.of(1)]},
        {windowFrames:64,maxCachedWindows:2,maxReadFrames:256});
      const lowA=cancellable.read(0,64,{priority:"background"});
      const lowB=cancellable.read(64,64,{priority:"background"});
      await entered;
      const urgent=cancellable.read(128,64,{priority:"scrub"});
      releases.splice(0).forEach(resolve=>resolve());
      for(let i=0;i<50&&readCalls<3;i++)await new Promise(resolve=>setTimeout(resolve,0));
      releases.splice(0).forEach(resolve=>resolve());
      const cancellation=await Promise.allSettled([lowA,lowB,urgent]);
      return {sampleRate,a:Array.from(a.channels[0]),b:Array.from(b.channels[0]),c:Array.from(c.channels[0]),
        tail:Array.from(tail.channels[0]),d:Array.from(d.channels[0]),delayedTail:Array.from(delayedTail.channels[0]),
        outputFrames:reader.sourceFrames,delayedOutputFrames:delayed.sourceFrames,
        stats:reader.stats(),delayedStats:delayed.stats(),channels:reader.channelCount,
        cancelled:cancellation.filter(item=>item.status==="rejected").map(item=>({name:item.reason.name,message:item.reason.message})),
        urgent:cancellation[2].status,readCalls};
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
    assert.equal(result.outputFrames,552);
    assert.equal(result.delayedOutputFrames,648);
    for(let i=0;i<result.tail.length;i++)assert.ok(Math.abs(result.tail[i]-reference.samples[512+i])<2e-4,
      `tail sample ${512+i}: ${result.tail[i]} != ${reference.samples[512+i]}`);
    for(let i=0;i<result.delayedTail.length;i++)assert.ok(Math.abs(result.delayedTail[i]-delayedReference.samples[600+i])<2e-4,
      `predelayed tail sample ${600+i}: ${result.delayedTail[i]} != ${delayedReference.samples[600+i]}`);
    assert.equal(result.channels,1);
    assert.equal(result.urgent,"fulfilled",JSON.stringify(result));
    assert.ok(result.cancelled.some(error=>error.name==="AbortError"&&error.message==="PCM window decode aborted"),
      JSON.stringify(result));
    assert.ok(result.stats.residentFrames<=128,JSON.stringify(result.stats));
    assert.ok(result.stats.residentWindows<=2,JSON.stringify(result.stats));
    assert.ok(result.delayedStats.residentFrames<=128,JSON.stringify(result.delayedStats));
  }finally{await cleanupTestProcesses(browser,[server]);}
});
