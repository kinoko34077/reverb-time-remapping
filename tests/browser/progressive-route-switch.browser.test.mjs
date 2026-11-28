import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("file-backed audio can switch progressive/native routes without losing its reader or playhead",async()=>{
  const port=18768;
  const windows=process.platform==="win32";
  const server=spawn(process.env.PYTHON_BIN||(windows?
    "C:/Users/kinok/AppData/Local/Programs/Python/Python310/python.exe":"python3"),
  ["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||
      (windows?"C:/Program Files/Google/Chrome/Application/chrome.exe":"/usr/bin/google-chrome"),headless:true,
      args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto(`http://127.0.0.1:${port}/app/`))?.ok();}catch{}
      if(!ready)await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.ok(ready,"test HTTP server unavailable");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み"),{timeout:30000});
    await page.$eval("#ir-length",element=>{element.value="0.1";element.dispatchEvent(new Event("change"));});
    await page.evaluate(()=>{
      const rate=44100,frames=rate*6,bytes=new ArrayBuffer(44+frames*4),view=new DataView(bytes);
      const ascii=(offset,value)=>[...value].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
      ascii(0,"RIFF");view.setUint32(4,bytes.byteLength-8,true);ascii(8,"WAVE");
      ascii(12,"fmt ");view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,2,true);
      view.setUint32(24,rate,true);view.setUint32(28,rate*4,true);view.setUint16(32,4,true);view.setUint16(34,16,true);
      ascii(36,"data");view.setUint32(40,frames*4,true);
      for(let i=0;i<frames;i++){
        const sample=Math.round(Math.sin(2*Math.PI*440*i/rate)*8000);
        view.setInt16(44+i*4,sample,true);view.setInt16(46+i*4,-sample,true);
      }
      const transfer=new DataTransfer();
      transfer.items.add(new File([bytes],"six-seconds-stereo.wav",{type:"audio/wav"}));
      const input=document.querySelector("#source-file");input.files=transfer.files;input.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>document.querySelector("#source").value==="file"&&
      Number(document.querySelector("#seek").max)>280_000,{timeout:30000});
    const native=await page.evaluate(()=>({status:document.querySelector("#status").textContent,
      max:Number(document.querySelector("#seek").max),wave:document.querySelector("#source-wave-position").textContent}));
    assert.ok(native.max>280_000&&native.max<400_000,JSON.stringify(native));
    await page.$eval("#seek",element=>{
      element.value=String(Math.round(Number(element.max)/2));
      element.dispatchEvent(new Event("input"));element.dispatchEvent(new Event("change"));
    });
    await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector("#source-wave-position").textContent)-3)<.03,{timeout:30000});

    await page.$eval("#ir-length",element=>{element.value="6";element.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み")&&
      document.querySelector("#status").textContent.includes("長尺逐次再生"),{timeout:30000});
    const progressive=await page.$eval("#source-wave-position",element=>element.textContent);
    assert.ok(Math.abs(parseFloat(progressive)-3)<.03,progressive);

    await page.$eval("#ir-length",element=>{element.value="0.1";element.dispatchEvent(new Event("change"));});
    await page.waitForFunction(()=>document.querySelector("#status").textContent.startsWith("準備済み")&&
      !document.querySelector("#status").textContent.includes("長尺逐次再生"),{timeout:30000});
    const nativeAgain=await page.$eval("#source-wave-position",element=>element.textContent);
    assert.ok(Math.abs(parseFloat(nativeAgain)-3)<.03,nativeAgain);
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
