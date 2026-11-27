import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";
test("regular entry prepares audio, switches comparison, seeks and retains last good WAV",async()=>{
  const port=18767,server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    // Observe actual output at the real preview GainNode; no substitute DSP.
    await page.evaluateOnNewDocument(()=>{
      const originalCeiling=AudioContext.prototype.createWaveShaper;
      AudioContext.prototype.createWaveShaper=function(){
        const node=originalCeiling.call(this),tap=this.createAnalyser();tap.fftSize=2048;
        node.connect(tap);window.__masterOutput=tap;return node;
      };
      const original=AudioContext.prototype.createGain;
      AudioContext.prototype.createGain=function(){
        const node=original.call(this);
        const tap=this.createAnalyser();tap.fftSize=2048;
        node.connect(tap);window.__observedOutput=tap;
        return node;
      };
    });
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/app/"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    await page.select("#source","sine");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").dataset.prepared==="true"&&!document.querySelector("#play").disabled);
    await page.click('[data-mode="normal"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true"&&!document.querySelector("#play").disabled);
    await page.evaluate(()=>{
      window.__playClicks=[];
      document.addEventListener("click",e=>window.__playClicks.push({id:e.target.id,tag:e.target.tagName,x:e.clientX,y:e.clientY}),true);
    });
    const layout=await page.evaluate(()=>({width:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth,viewport:innerWidth}));
    assert.ok(layout.scroll<=layout.width+1,JSON.stringify(layout));
    await page.click("#play");
    await new Promise(r=>setTimeout(r,300));
    console.log("P1 playback click diagnostic",JSON.stringify(await page.evaluate(()=>{
      const el=document.querySelector("#play"),r=el.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {clicks:window.__playClicks,status:document.querySelector("#status").textContent,frames:document.querySelector("#status").dataset.renderedFrames,disabled:el.disabled,
        hit:hit?.id,rect:{x:r.x,y:r.y,w:r.width,h:r.height},scrollY,viewport:[innerWidth,innerHeight]};
    })),errors);
    await page.waitForFunction(()=>Number(document.querySelector("#status").dataset.renderedFrames)>256);
    await page.waitForFunction(()=>{
      const tap=window.__observedOutput;if(!tap)return false;
      const pcm=new Float32Array(tap.fftSize);tap.getFloatTimeDomainData(pcm);
      return pcm.every(Number.isFinite)&&pcm.some(x=>Math.abs(x)>.001)&&pcm.every(x=>Math.abs(x)<=.900001);
    });
    await page.$eval("#master-volume",el=>{el.value="0";el.dispatchEvent(new Event("input"));});
    await page.waitForFunction(()=>{
      const a=window.__masterOutput;if(!a)return false;const pcm=new Float32Array(a.fftSize);
      a.getFloatTimeDomainData(pcm);return pcm.every(x=>Math.abs(x)<.0001);
    });
    await page.$eval("#master-volume",el=>{el.value="100";el.dispatchEvent(new Event("input"));});
    await page.waitForFunction(()=>{
      const a=window.__masterOutput,pcm=new Float32Array(a.fftSize);a.getFloatTimeDomainData(pcm);
      return pcm.some(x=>Math.abs(x)>.001);
    });
    await page.click("#pause");
    await page.waitForFunction(()=>document.querySelector("#status").textContent==="一時停止"&&!document.querySelector("#seek").disabled);
    await page.$eval("#seek",el=>{el.value="24000";el.dispatchEvent(new Event("input"));el.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>!document.querySelector("#seek").disabled);
    const before=await page.$eval("#seek",el=>Number(el.value));
    const waveState=await page.$eval("#wave-detail",el=>({span:Number(el.dataset.spanFrames),position:Number(el.getAttribute("aria-valuenow")),painted:(()=>{const p=el.getContext("2d").getImageData(0,0,el.width,el.height).data;for(let i=0;i<p.length;i+=4)if(p[i]===117&&p[i+1]===217&&p[i+2]===197)return true;return false;})()}));
    assert.ok(waveState.painted&&waveState.span>0);
    await page.focus("#wave-detail");await page.keyboard.press("Home");
    await page.waitForFunction(()=>Number(document.querySelector("#wave-detail").getAttribute("aria-valuenow"))===0&&!document.querySelector("#seek").disabled);
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(()=>Number(document.querySelector("#wave-detail").getAttribute("aria-valuenow"))===4800&&!document.querySelector("#seek").disabled);
    const common=Number(await page.$eval("#seek",el=>el.value));
    assert.equal(common,71999+4800);
    const rect=await page.$eval("#wave-detail",el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};});
    await page.mouse.move(rect.x+rect.w*.65,rect.y+rect.h*.65);
    await page.mouse.down();await page.mouse.move(rect.x+rect.w*.4,rect.y+rect.h*.65,{steps:5});await page.mouse.up();
    await page.waitForFunction(()=>Number(document.querySelector("#wave-detail").getAttribute("aria-valuenow"))>4800&&!document.querySelector("#seek").disabled);
    const dragged=Number(await page.$eval("#wave-detail",el=>el.getAttribute("aria-valuenow")));
    assert.equal(Number(await page.$eval("#seek",el=>el.value)),71999+dragged);
    await page.focus("#wave-detail");await page.keyboard.press("Home");await page.waitForFunction(()=>Number(document.querySelector("#wave-detail").getAttribute("aria-valuenow"))===0&&!document.querySelector("#seek").disabled);
    await page.keyboard.press("ArrowRight");await page.waitForFunction(()=>Number(document.querySelector("#wave-detail").getAttribute("aria-valuenow"))===4800&&!document.querySelector("#seek").disabled);
    await page.click("#wave-zoom-in");
    assert.ok(Number(await page.$eval("#wave-detail",el=>el.dataset.spanFrames))<waveState.span);
    const zoom=await page.$eval("#wave-detail",el=>el.dataset.spanFrames);
    await page.setViewport({width:844,height:390,isMobile:true,hasTouch:true});
    await page.waitForFunction(z=>document.querySelector("#wave-detail").dataset.spanFrames===z&&Number(document.querySelector("#wave-detail").getAttribute("aria-valuenow"))===4800,{},zoom);
    await page.setViewport({width:390,height:844,isMobile:true,hasTouch:true});
    await page.$eval("#seek",(el,frame)=>{el.value=String(frame);el.dispatchEvent(new Event("input"));el.dispatchEvent(new Event("change"));},before);
    await page.waitForFunction(()=>!document.querySelector("#seek").disabled);
    await page.click('[data-mode="reverse"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="reverse"]').getAttribute("aria-pressed")==="true"&&!document.querySelector("#seek").disabled);
    assert.equal(await page.$eval("#seek",el=>Number(el.value)),before);
    await page.focus("#wet");await page.$eval("#wet",el=>{el.value="75.125";el.dispatchEvent(new Event("input"));});
    await page.click("#apply-mix");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("75.125%")&&!document.querySelector("#seek").disabled);
    await page.evaluate(()=>{
      const d=new DataTransfer();d.items.add(new File(["bad"],"bad.wav",{type:"audio/wav"}));
      const input=document.querySelector("#source-file");input.files=d.files;input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("処理できません")&&!document.querySelector("#play").disabled);
    assert.equal(await page.$eval("#source",el=>el.value),"sine");
    assert.equal(await page.$eval('[data-mode="reverse"]',el=>el.getAttribute("aria-pressed")),"true");
    // Actual local input, different source rate; the app must not silently
    // keep the old synthetic material or use a placeholder waveform.
    await page.evaluate(()=>{
      const rate=44100,n=rate/5,bytes=new ArrayBuffer(44+n*2),v=new DataView(bytes);
      const tag=(p,s)=>{for(let i=0;i<s.length;i++)v.setUint8(p+i,s.charCodeAt(i));};
      tag(0,"RIFF");v.setUint32(4,36+n*2,true);tag(8,"WAVE");tag(12,"fmt ");
      v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
      v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
      tag(36,"data");v.setUint32(40,n*2,true);
      for(let i=0;i<n;i++)v.setInt16(44+i*2,Math.round(12000*Math.sin(2*Math.PI*220*i/rate)),true);
      const data=new DataTransfer();data.items.add(new File([bytes],"local-44100.wav",{type:"audio/wav"}));
      const input=document.querySelector("#source-file");input.files=data.files;input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>document.querySelector("#source").value==="file"&&!document.querySelector("#prepare").disabled);
    await page.$eval("#predelay",el=>el.value="-20");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("準備済み")&&!document.querySelector("#play").disabled);
    // Source length 0.2s at 48k, IR length 1.5s; common span accounts for
    // both normal/reverse Wet and negative signed delay.
    const max=await page.$eval("#seek",el=>Number(el.max));
    assert.equal(max,153598);
    assert.ok(Number.parseFloat(await page.$eval("#time",el=>el.textContent))<0);
    await page.$eval("#ir-window-start",el=>el.value="500");
    await page.$eval("#ir-window-length",el=>el.value="150");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#window-range").textContent.includes("500.000 – 650.000")&&!document.querySelector("#play").disabled);
    await page.click('[data-mode="ir-window"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="ir-window"]').getAttribute("aria-pressed")==="true"&&!document.querySelector("#play").disabled);
    const native=await page.evaluate(async()=>{
      const {prepareComparison}=await import("/src/comparison-session.mjs");
      const sr=48000,source={sampleRate:sr,channels:[Float32Array.of(1)]},ir={sampleRate:sr,channels:[Float32Array.of(1,.5,.1,.05),Float32Array.of(-1,-.5,-.1,-.05)]};
      const c=await prepareComparison(source,ir,{predelay:-1/sr,irWindow:{start:2/sr,duration:2/sr}});
      const at=-1-c.interval.start;
      return {left:Array.from(c.signals["ir-window"].channels[0].slice(at,at+2)),right:Array.from(c.signals["ir-window"].channels[1].slice(at,at+2))};
    });
    assert.ok(Math.abs(native.left[0]-.1)<1e-6&&Math.abs(native.left[1]-.05)<1e-6);
    assert.ok(Math.abs(native.right[0]+.1)<1e-6&&Math.abs(native.right[1]+.05)<1e-6);
    await page.$eval("#ir-window-start",el=>el.value="2000");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("処理できません")&&!document.querySelector("#play").disabled);
    assert.ok((await page.$eval("#window-range",el=>el.textContent)).includes("500.000 – 650.000"));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    await page.setViewport({width:1280,height:800});
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
