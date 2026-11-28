import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("progressive normal convolution restores only the selected point's prior IR history",async()=>{
  const port=18768;
  const server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio"]});
    const page=await browser.newPage();
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto(`http://127.0.0.1:${port}/tests/browser/blank.html`))?.ok();}catch{}
      if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,"test HTTP server unavailable");
    const tail=await page.evaluate(async()=>{
      const {renderConvolutionHistory}=await import("/src/progressive-convolution.mjs");
      const input=Float32Array.of(1,.5,-.25,.75,0);
      const source={sourceFrames:input.length,channelCount:1,sampleRate:48000,
        async read(start,count){return {startFrame:start,channels:[input.slice(start,start+count)]};}};
      const ir={origin:0,sampleRate:48000,channels:[Float32Array.of(.5,.25,-.1)]};
      const context=new OfflineAudioContext(1,8,48000);
      const result=await renderConvolutionHistory(context,source,ir,3);
      return {...result,channels:result.channels.map(channel=>Array.from(channel))};
    });
    assert.equal(tail.startFrame,3);
    assert.deepEqual(tail.channels.map(channel=>channel.length),[2]);
    assert.ok(Math.abs(tail.channels[0][0]-(-.1125))<1e-5,JSON.stringify(tail));
    assert.ok(Math.abs(tail.channels[0][1]-.025)<1e-5,JSON.stringify(tail));
  }finally{await cleanupTestProcesses(browser,[server]);}
});
