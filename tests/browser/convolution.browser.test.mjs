import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";
test("native OfflineAudioContext matches independent oracle across rates and routing",async()=>{
  const port=18766;
  const server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/tests/browser/blank.html"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready,"test HTTP server unavailable");
    const report=await page.evaluate(async()=>{
      const {renderConvolution}=await import("/src/convolution.mjs");
      const {createLiveConvolutionGraph}=await import("/src/live-convolution.mjs");
      const {referenceConvolution}=await import("/tests/helpers/time-reference.mjs");
      const results=[];
      for(const sampleRate of [44100,48000,96000]){
        for(const inputs of [[[1]],[[0,0,0]],[[.2,-.4,.1,.3],[-.2,.1,.4,.5]]])
          for(const ir of [[[.7,-.2,.1]],[[.7,-.2,.1],[-.3,.4,.2]]])
            for(const reverse of [false,true])for(const delay of [-3,2]){
              const input={channels:inputs.map(v=>Float32Array.from(v)),sampleRate};
              const kernel={channels:ir.map(v=>Float32Array.from(v)),sampleRate};
              const y=await renderConvolution(input,kernel,{reverse,delay});
              for(let c=0;c<y.channels.length;c++){
                const ref=referenceConvolution(input.channels[input.channels.length===1?0:c],kernel.channels[kernel.channels.length===1?0:c],{reverse,delay});
                let error=0,peak=0;
                for(let i=0;i<ref.samples.length;i++){
                  error=Math.max(error,Math.abs(y.channels[c][i]-ref.samples[i]));peak=Math.max(peak,Math.abs(ref.samples[i]));
                }
                results.push({sampleRate,reverse,delay,c,error,limit:1e-6*Math.max(1,peak),origin:y.origin,expectedOrigin:ref.origin,length:y.channels[c].length,expectedLength:ref.samples.length});
              }
            }
      }
      const sampleRate=48000,delay=48,frames=4800,h=new Float32Array(49);h[0]=h[48]=1;
      const liveContext=new OfflineAudioContext(2,8,sampleRate);
      const liveInput=liveContext.createBuffer(2,4,sampleRate);
      liveInput.copyToChannel(Float32Array.of(1,2,0,0),0);
      liveInput.copyToChannel(Float32Array.of(0,1,0,0),1);
      const liveIR={sampleRate,channels:[Float32Array.of(.5,.25),Float32Array.of(.25,-.5)]};
      const liveGraph=createLiveConvolutionGraph(liveContext,{sourceChannels:2,ir:liveIR,wet:1});
      const liveSource=liveContext.createBufferSource();liveSource.buffer=liveInput;
      liveSource.connect(liveGraph.input);liveGraph.output.connect(liveContext.destination);liveSource.start();
      const rendered=await liveContext.startRendering();
      const live=[...Array(2)].map((_,c)=>Array.from(rendered.getChannelData(c).slice(0,5)));
      const amplitude=[];
      for(const hz of [500,1000]){
        const x=Float32Array.from({length:frames},(_,n)=>.2*Math.sin(2*Math.PI*hz*n/sampleRate));
        const y=await renderConvolution({channels:[x],sampleRate},{channels:[h],sampleRate});
        let power=0;
        for(let n=delay;n<frames;n++)power+=y.channels[0][n]**2;
        amplitude.push(Math.sqrt(power/(frames-delay)));
      }
      return {results,amplitude,live};
    });
    assert.ok(report.results.length>0);
    for(const r of report.results){
      assert.equal(r.origin,r.expectedOrigin);assert.equal(r.length,r.expectedLength);assert.ok(r.error<=r.limit,JSON.stringify(r));
    }
    assert.ok(report.amplitude[0]<1e-6,JSON.stringify(report.amplitude));
    assert.ok(Math.abs(report.amplitude[1]-.4/Math.sqrt(2))<.001,JSON.stringify(report.amplitude));
    for(const [c,expected] of [[0,[.5,1.25,.5,0,0]],[1,[0,.25,-.5,0,0]]])
      for(let i=0;i<expected.length;i++)assert.ok(Math.abs(report.live[c][i]-expected[i])<1e-6,JSON.stringify(report.live));
    assert.deepEqual(errors,[]);
    console.log("native convolution",report.results.length,"channel cases; max error",Math.max(...report.results.map(r=>r.error)),"comb RMS",report.amplitude);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
