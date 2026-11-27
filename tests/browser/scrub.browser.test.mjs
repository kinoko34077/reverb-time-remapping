import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("real Wet Buffer/PV Worklets keep independent axes and non-DC freeze output",async()=>{
  const port=18768,server=spawn(process.env.PYTHON_BIN||"python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
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
    await page.evaluate(()=>{
      window.__playClicks=[];
      document.addEventListener("click",e=>window.__playClicks.push({id:e.target.id,tag:e.target.tagName,x:e.clientX,y:e.clientY}),true);
    });
    const layout=await page.evaluate(()=>{
      const width=document.documentElement.clientWidth;
      return {width,scroll:document.documentElement.scrollWidth,viewport:innerWidth,overflow:[...document.querySelectorAll("body,body *")].filter(e=>e.getBoundingClientRect().right>width+.5||e.scrollWidth>e.clientWidth+1).map(e=>({tag:e.tagName,id:e.id,cls:e.className,x:e.getBoundingClientRect().x,w:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right,scroll:e.scrollWidth,client:e.clientWidth,overflow:getComputedStyle(e).overflowX})).slice(0,35)};
    });
    assert.ok(layout.scroll<=layout.width+1,JSON.stringify(layout));
    await page.click("#play");
    await new Promise(r=>setTimeout(r,300));
    console.log("P1 playback click diagnostic",JSON.stringify(await page.evaluate(()=>{
      const el=document.querySelector("#play"),r=el.getBoundingClientRect();
      const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return {clicks:window.__playClicks,status:document.querySelector("#status").textContent,frames:document.querySelector("#status").dataset.renderedFrames,disabled:el.disabled,
        hit:hit?.id,rect:{x:r.x,y:r.y,w:r.width,h:r.height},scrollY,viewport:[innerWidth,innerHeight]};
    })),errors);await enabled();
    await page.waitForFunction(()=>Number(document.querySelector("#source-seek").value)>26000);
    assert.equal(await pos("wet"),30000);await audible();
    await page.select("#wet-calibration","compensated");await enabled();
    assert.match(await page.$eval("#wet-calibration-applied",el=>el.textContent),/^Wet補正目標 ×/);
    assert.equal(await pos("wet"),30000);
    await page.select("#wet-calibration","natural");await enabled();
    assert.equal(await page.$eval("#wet-calibration-applied",el=>el.textContent),"Wet自然減衰 ×1");
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
    // Source exhaustion must not stop a frozen Wet when replacing a pair.
    await page.$eval("#wet-repeat",el=>{el.checked=false;el.dispatchEvent(new Event("change"));});await enabled();
    await field("wet-seek",30000);await field("wet-speed",0);
    const last=await page.$eval("#source-seek",el=>Number(el.max));
    await field("source-seek",last-64);await field("source-speed",1);
    await page.click("#play");await enabled();
    await page.waitForFunction(()=>Number(document.querySelector("#source-seek").value)===Number(document.querySelector("#source-seek").max));
    assert.equal(await pos("wet"),30000);await audible();
    await choose("wet-buffer");
    await new Promise(r=>setTimeout(r,250));await audible();
    assert.equal(await pos("wet"),30000);assert.equal(await pos("source"),last);
    await page.click("#pause");await enabled();
    await page.click("#play");await enabled();await audible();assert.equal(await pos("wet"),30000);
    await page.click("#pause");await enabled();
    // Arbitrary repeat uses the original common frame coordinates.
    await field("source-seek",16000);await field("source-speed",0);
    const offset=Number(await page.$eval("#wet-range-start",el=>el.value));
    await field("wet-range-start",offset+24000/48000);
    await field("wet-range-end",offset+30000/48000);
    await field("wet-speed",1);
    await page.$eval("#wet-repeat",el=>{el.checked=true;el.dispatchEvent(new Event("change"));});await enabled();
    await field("wet-seek",27000);
    await page.click("#play");await enabled();
    const rangeSamples=await page.evaluate(async()=>{
      const samples=[];for(let i=0;i<40;i++){
        await new Promise(r=>setTimeout(r,15));
        samples.push(Number(document.querySelector("#wet-seek").value));
      }return samples;
    });
    assert.ok(rangeSamples.every(v=>v>=24000&&v<30000),JSON.stringify(rangeSamples));
    assert.ok(rangeSamples.some((v,i)=>i&&v<rangeSamples[i-1]),JSON.stringify(rangeSamples));
    assert.equal(await pos("source"),16000);await audible();
    await page.click("#pause");await enabled();
    const applied=await page.$eval("#wet-range-applied",el=>el.textContent);
    await field("wet-range-end",offset+23000/48000);
    assert.match(await page.$eval("#status",el=>el.textContent),/反復区間/);
    assert.equal(await page.$eval("#wet-range-applied",el=>el.textContent),applied);
    // The user must be able to escape an active loop with an invalid draft.
    await page.$eval("#wet-repeat",el=>{el.checked=false;el.dispatchEvent(new Event("change"));});await enabled();
    assert.match(await page.$eval("#wet-range-applied",el=>el.textContent),/^反復範囲:/);
    assert.equal(Number(await page.$eval("#wet-range-end",el=>el.value)),offset+23000/48000);
    await field("wet-range-end",offset+30000/48000);
    await page.$eval("#wet-repeat",el=>{el.checked=true;el.dispatchEvent(new Event("change"));});await enabled();
    await choose("wet-spectral");
    assert.equal(await page.$eval("#wet-range-applied",el=>el.textContent),applied);
    await page.select("#wet-loop-style","pingpong");await enabled();
    assert.match(await page.$eval("#wet-range-applied",el=>el.textContent),/^往復中:/);
    await field("wet-seek",27000);await page.click("#play");await enabled();
    const bouncing=await page.evaluate(async()=>{
      const samples=[];for(let i=0;i<90;i++){
        await new Promise(r=>setTimeout(r,12));
        samples.push(Number(document.querySelector("#wet-seek").value));
      }return samples;
    });
    assert.ok(bouncing.every(v=>v>=24000&&v<30000),JSON.stringify(bouncing));
    assert.ok(bouncing.some((v,i)=>i&&v<bouncing[i-1])&&bouncing.some((v,i)=>i&&v>bouncing[i-1]));
    assert.equal(await pos("source"),16000);await audible();
    await field("wet-speed",0);
    const frozen=await pos("wet");await new Promise(r=>setTimeout(r,120));assert.equal(await pos("wet"),frozen);
    await audible();
    await field("wet-speed",-1);await audible();
    await page.click("#pause");await enabled();
    await choose("wet-buffer");
    assert.match(await page.$eval("#wet-range-applied",el=>el.textContent),/^往復中:/);
    await page.click("#play");await enabled();await audible();
    await page.$eval("#wet-repeat",el=>{el.checked=false;el.dispatchEvent(new Event("change"));});await enabled();
    assert.match(await page.$eval("#wet-range-applied",el=>el.textContent),/^反復範囲:/);
    await page.click("#pause");await enabled();
    // Drag a Source range handle through multiple pending updates.
    await field("source-speed",1);
    await field("source-range-start",offset+24000/48000);
    await field("source-range-end",offset+36000/48000);
    await page.select("#source-loop-style","pingpong");await enabled();
    await page.$eval("#source-repeat",el=>{el.checked=true;el.dispatchEvent(new Event("change"));});await enabled();
    await field("source-seek",30000);
    await page.$eval("#wave-detail",el=>el.scrollIntoView({block:"center"}));
    const geometry=await page.evaluate(()=>{
      const c=document.querySelector("#wave-detail"),m=document.querySelector("#wave-a-marker");
      const r=c.getBoundingClientRect(),a=m.getBoundingClientRect();
      return {x:a.x+a.width/2,y:r.y+r.height*.6,w:r.width,span:Number(c.dataset.spanFrames),center:Number(c.getAttribute("aria-valuenow")),left:r.left};
    });
    const targetX=geometry.x-geometry.w*.10;
    const desired=geometry.center+(targetX-geometry.left-geometry.w/2)*geometry.span/geometry.w;
    const sourceOffset=Math.round(-offset*48000);
    const wetHeld=await pos("wet");
    await page.mouse.move(geometry.x,geometry.y);await page.mouse.down();
    await page.mouse.move(targetX,geometry.y,{steps:8});await page.mouse.up();
    await page.waitForFunction((target,tol)=>{
      const field=document.querySelector("#source-range-start");
      return Math.abs(Number(field.value)*48000-target)<tol&&!document.querySelector("#play").disabled;
    },{},desired,geometry.span/geometry.w*2);
    assert.equal(await pos("wet"),wetHeld);
    assert.ok(sourceOffset>0);
    // Direct actual output measurement with a known 10:1 Wet decay fixture.
    const levels=await page.evaluate(async()=>{
      const {createScrubPair}=await import("/src/scrub-pair.mjs");
      const c=new AudioContext({sampleRate:48000}),sr=c.sampleRate,n=sr;
      const signal=(low,high)=>({sampleRate:sr,origin:0,channels:[Float32Array.from({length:n},
        (_,i)=>(i<n/2?high:low)*Math.sin(2*Math.PI*440*i/sr))]});
      const dry=signal(.2,.2),wet=signal(.02,.2);
      const p=await createScrubPair({ctx:c,dry,wet,mode:"wet-buffer",mix:1,solo:"wet",
        positions:{source:{frame:36000,speed:0},wet:{frame:36000,speed:0}}});
      const tap=c.createAnalyser();tap.fftSize=2048;p.connect(tap);tap.connect(c.destination);
      const measure=async()=>{await new Promise(r=>setTimeout(r,180));const a=new Float32Array(tap.fftSize);
        tap.getFloatTimeDomainData(a);return Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);};
      try{
        await p.play();const natural=await measure();
        p.setCalibration("compensated");const compensated=await measure(),scale=p.calibration.targetScale;
        p.setMix(1,"dry");const dryComp=await measure();
        p.setCalibration("natural");const dryNatural=await measure();
        return {natural,compensated,scale,dryComp,dryNatural,axes:p.axes};
      }finally{p.dispose();tap.disconnect();await c.close();}
    });
    assert.ok(levels.natural>.008&&levels.natural<.02,JSON.stringify(levels));
    assert.ok(levels.scale>6.9&&levels.scale<7.3,JSON.stringify(levels));
    assert.ok(Math.abs(levels.compensated/levels.natural-levels.scale)<.3,JSON.stringify(levels));
    assert.ok(Math.abs(levels.dryComp-levels.dryNatural)<.005,JSON.stringify(levels));
    assert.equal(levels.axes.wet.frame,36000);assert.equal(levels.axes.source.frame,36000);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
