import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("finite IR spectral kernel really reaches native convolution in Chrome",async()=>{
  const port=18770,server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    let ready=false;for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/tests/browser/blank.html"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    const report=await page.evaluate(async()=>{
      const {renderSpectralWet}=await import("/src/ir-spectral.mjs");
      const sr=48000,channel=Float32Array.from({length:16000},(_,i)=>.2*Math.sin(2*Math.PI*440*i/sr));
      const ir={sampleRate:sr,channels:[channel,channel.map(v=>-v)]};
      const input={sampleRate:sr,channels:[Float32Array.of(1)]};
      const results=[];
      for(const speed of [1,0,-1,.5]){
        const {kernel,wet}=await renderSpectralWet(input,ir,
          {startFrame:speed===1?0:8000,speed,outputFrames:4096},{delay:-48});
        let error=0,peak=0,dc=0;
        for(let i=0;i<4096;i++){
          error=Math.max(error,Math.abs(kernel.channels[0][i]-wet.channels[0][i]),
            Math.abs(kernel.channels[1][i]-wet.channels[1][i]));
          peak=Math.max(peak,Math.abs(wet.channels[0][i]));dc+=wet.channels[0][i];
        }
        results.push({speed,error,peak,dc:dc/4096,origin:wet.origin,algorithm:kernel.trajectory.algorithm});
      }
      return results;
    });
    for(const r of report){
      assert.equal(r.origin,-48);assert.ok(r.error<1e-6,JSON.stringify(r));
      assert.ok(r.peak>.04&&Math.abs(r.dc)<.04,JSON.stringify(r));
    }
    assert.deepEqual(errors,[]);
    console.log("IR spectral impulse",report);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
