import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";
// Real MP3s generated from synthetic tones with FFmpeg/libmp3lame;
// mono 32 kHz and stereo 44.1 kHz. No third-party recording.
const mono="//sowAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAFAAADhABcXFxcXFxcXFxcXFxcXFxcXFxchYWFhYWFhYWFhYWFhYWFhYWFhYWurq6urq6urq6urq6urq6urq6urtfX19fX19fX19fX19fX19fX19fX//////////////////////////8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJAVAAAAAAAAAA4QYKRs6AAAA//sYxAAABlQ1QnWBgAEEjO93HqACBkkAASHRXQDoB0i2XxJAQZDHep1iaxl211u+/8bl4AAAAAAAAhATB8HwfflPT/7+j39FtIFu4HAwHA4HAAAAAA+gh0gu8EoksrkS4oiOXI0mjZNpgDQBPgBRBA3fisQj0e/5EPh8aPR7+DQVBURf4VBURHlAUMgBmAsB//sYxAODxvQpHB3kgCjfhaDBz/SMKYIQKZgKAsGFuJAZGJ6BpU83Hugd+ZP50xjSiZGKuGoYJYCgYAeYCQBbBXcWMAFgaRAgxGCzIgqM5k814hDpbrMLKCFjMp2kY/qATSMPANZj0HXDBNFR0gAsIIjCAcA8kABW9x3yk/KlAQdFiEPHQMYYtQDkoaMKUBPz//sYxAkDxzAtBg5/ZIDwhaDBz+yQMV3ws/dYDbMLmM2jCPg4QwPQEtNtkDNk0xsoMGEwaAN1hTqxblX+swcDzCYWMOCUxmQjLh/NdxYwdYN5Mmd+1zxGBYswUgnEMW8C+jBlAQc7N+NcRTMSIxYNBQUzWAnJi3P/WjAYQEUwBABoMBiAgjA7gLgwNUHPMIBD//sYxAuACTgtChX3gCEHE6sDMoAAizHhSzsx+vt1NhECJjELw5wxhYLkMSQDlDCFgTYwLgAGMBzAhTAWQDUDAIZcQWwYZL3PB96r/xFOU4DwESZfxRmXBgHD3Hl7XYd8AIDQoG35gNxcWUV/zw8FDDYZv/xcXcURJVYa///F3cxEPPhot+kEAGH6PDFxkJRO//sYxAMDxZQjHjzBgAAAADSAAAAEPkoSgRRiCBERXWlzwmBoGn1gqdywd4l5YGuCrrywdogq68sHZKCtTEFNRTMuMTAw"+"V".repeat(100);
const stereo="//tQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAASW5mbwAAAA8AAAAIAAAFtgA/Pz8/Pz8/Pz8/Pz9bW1tbW1tbW1tbW1t2dnZ2dnZ2dnZ2dnZ2kpKSkpKSkpKSkpKSra2tra2tra2tra2trcnJycnJycnJycnJyeTk5OTk5OTk5OTk5OT///////////////8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJAYwAAAAAAAABbZH6mXFAAAAAAAAAAAAAAAAAAAAAP/7MEQAAADJBVRtMGAIGqALfaGEAYPIM0oZsQAAcgZqwzIgAAAAAALAAAAADdWVAQAAAIIhg5cDg+H/1g+SCABJZcAAAAfB+OBMH34IAgCDnFwffiAMcHxFcGXA5LcB0QM0AlsBADEqf5f8PRr//wonwoi4VBV9mBblH8EKwu0FQxLoR7s+adGsflvQonwoi4VBVTAlB4MPUeAzKf/7MkQEjzD2BsmHeAAIH2FJ1O4MAQO8GxgOe4AgcYSmodwxBUzjbOFdMRwOMIDRLXGAGAUpNua1bOgAABaBj8ed60gyYMB5hAbmwN6JQ1VypYdltaHotKRSmjUAcUi5qq5Dn8oMmdfNBoQTmPwMJDUSA6wbMoZyCALDeq8w3NPRDmOCUZLaQYliGB3JWhUTT49e6CoyLNYyukkwvFr/+zJEBI8w8QbFg7/YCB3hKYhnuTFDeBseDntAIHmEpQGvZMTDMiQDbTvfQ0BvMVNgQKoeMUVE3s8EAcAAd529J29XUaVp0LdZjOTRzHlrliu9GXejOUYwCVDHM7Mez3M13x6z3fjPszDFACFLYKaMnil/CXv4ztMQtOZIcdWWafwrpjLB9nG4BAVMmsw1Ka20VR5gOndTOkczOscN//syRAWP8NkGx4N+2AggwRkQY54hQ+gbFA5/gCB4BKVBv2jFM+goNTBwMiA4bLWKANblGc27C50TAKU1YMSkkzpKDU5juMn8IwWBXHgCFvvZI5y2AGvludtxBjbSKgafuEbHyk2azHxlgKhBWEgolosC7VLqbiD7sAL7hQaANiYS7OphoBAHAIg40jiy5+ZdZ7UqMhjXMpZMMK0bCP/7MEQFD/DxBsWDv9gIHYEpQGvaMUNoGx4Oe0AgfgRkga9oxTH4Q3Q6r3M7bjEDcKiyDaz1Qt9O45WbUta8WdNX2NARYgwjBEzrrDKBy1ymrXodl3IIIKZkCaGQb50bHQ8h9/poGBiSoACFs1B2SRe9nGHLXYg+YQAZ8qfSITaRmP+K8cJmYkYXdWGcmGqUYtUiVjkFYzN1wjmKCv/7MkQFjzDUBsgDftgIIOEZAGPYI0PUGyoV4AAggARnUroQBSPLGwFEA43CBAu2sO7ErwmHDUwLhmBBx+YGAKhhIihm0pLCZdwb58EGDYI/csp7AeYIYIZhPiymSKjGaigdxhjBMDQOpbcwBwCVvvGwe3oJAAOAfXjcGJeIBF4mBICmLsNGH4YgoQy66z+Sh5Oh/AvWj16I78IXR3H/+zJkBQABAAlRhmwAAB6hOmDNAAAD+ClaGYGAAFyE7QMaIABQ6mHsJoIIFakyAEBEmHckO5NNtPLfFdYdpGfI0tIfsJADgHRRTUDjYhtDYuXcgbkWvSn/SIIo2TL8/48EOCyKJf8vtz2P/ReXEKJQCbJRID+uO/3BNRyV5LCXV543UljBZ6Q+dwyGKtiG/pVMQU1FMy4xMDBVVVVV//syZAaP8AAAaQcAAAgAAA0g4AABAAABpAAAACAAADSAAAAE"+"V".repeat(161)+"Q==";
test("actual MP3 source and IR import, comparison, and last-good rejection",async()=>{
  assert.equal(createHash("sha256").update(Buffer.from(mono,"base64")).digest("hex"),"1d62135b36a0c015a4b8e1e653c4436197636774cf3c2b487da4b8ef7417d368");
  assert.equal(createHash("sha256").update(Buffer.from(stereo,"base64")).digest("hex"),"d9d7a9f25486fd108f8ff0ddca58315bbd69fd5dd41dadafbd8b63d437e1867c");
  const port=18772,server=spawn("python3",["-m","http.server",String(port),"--bind","127.0.0.1"],{stdio:"ignore"});
  let browser;
  try{
    browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||"/usr/bin/google-chrome",headless:true,args:["--no-sandbox","--disable-dev-shm-usage","--mute-audio","--autoplay-policy=no-user-gesture-required"]});
    const page=await browser.newPage(),errors=[];page.on("pageerror",e=>errors.push(e.message));
    let ready=false;
    for(let i=0;i<30&&!ready;i++){
      try{ready=(await page.goto("http://127.0.0.1:"+port+"/app/"))?.ok();}catch{}
      if(!ready)await new Promise(r=>setTimeout(r,200));
    }
    assert.ok(ready);
    const result=await page.evaluate(async(mono,stereo)=>{
      const {readLocalAudio}=await import("/src/materials.mjs");
      const file=(s,name)=>new File([Uint8Array.from(atob(s),c=>c.charCodeAt(0))],name,{type:"audio/mpeg"});
      const a=await readLocalAudio(file(mono,"mono.mp3")),b=await readLocalAudio(file(stereo,"stereo.mp3"));
      return {a:a.channels.length,b:b.channels.length,rateA:a.sampleRate,rateB:b.sampleRate,
        lenA:a.channels[0].length,lenB:b.channels[0].length,
        finite:[...a.channels,...b.channels].every(c=>c.every(Number.isFinite)&&c.some(x=>Math.abs(x)>.01)),
        distinct:b.channels[0].some((x,i)=>Math.abs(x-b.channels[1][i])>.01)};
    },mono,stereo);
    assert.equal(result.a,1);assert.equal(result.b,2);assert.equal(result.rateA,48000);assert.equal(result.rateB,48000);
    assert.ok(result.lenA>4800&&result.lenB>4800);assert.ok(result.finite&&result.distinct);
    console.log("MP3 decoded",result);
    const select=async(id,bytes,name)=>page.evaluate((id,bytes,name)=>{
      const d=new DataTransfer();d.items.add(new File([Uint8Array.from(atob(bytes),c=>c.charCodeAt(0))],name,{type:"audio/mpeg"}));
      const input=document.querySelector("#"+id);input.files=d.files;input.dispatchEvent(new Event("change"));
    },id,bytes,name);
    await select("source-file",mono,"mono.mp3");
    await page.waitForFunction(()=>document.querySelector("#source").value==="file"&&!document.querySelector("#prepare").disabled);
    await select("ir-file",stereo,"stereo.mp3");
    await page.waitForFunction(()=>document.querySelector("#ir").value==="file"&&!document.querySelector("#prepare").disabled);
    await page.$eval("#ir-window-start",el=>el.value="0");
    await page.$eval("#ir-window-length",el=>el.value="50");
    await page.click("#prepare");
    await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("準備済み")&&!document.querySelector("#play").disabled);
    await page.click('[data-mode="normal"]');
    await page.waitForFunction(()=>document.querySelector('[data-mode="normal"]').getAttribute("aria-pressed")==="true"&&!document.querySelector("#play").disabled);
    const max=await page.$eval("#seek",el=>Number(el.max));
    assert.equal(max,result.lenA+2*(result.lenB-1));
    await page.$eval("#seek",(el,n)=>{el.value=String(n);el.dispatchEvent(new Event("input"));el.dispatchEvent(new Event("change"));},result.lenB-1);
    await page.waitForFunction(()=>!document.querySelector("#play").disabled);
    await page.click("#play");
    await page.waitForFunction(()=>Number(document.querySelector("#status").dataset.renderedFrames)>256);
    for(const [id,selector] of [["source-file","#source"],["ir-file","#ir"]]){
      await select(id,"YmFk","bad.mp3");
      await page.waitForFunction(()=>document.querySelector("#status").textContent.includes("処理できません")&&!document.querySelector("#play").disabled);
      assert.equal(await page.$eval(selector,el=>el.value),"file");
      assert.equal(await page.$eval("#seek",el=>Number(el.max)),max);
      assert.equal(await page.$eval('[data-mode="normal"]',el=>el.getAttribute("aria-pressed")),"true");
    }
    assert.deepEqual(errors,[]);
  }finally{await cleanupTestProcesses(browser,[server]);}
});
