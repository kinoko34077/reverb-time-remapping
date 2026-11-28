import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import puppeteer from "puppeteer-core";
import {cleanupTestProcesses} from "../../shared/atf/test-process-cleanup.mjs";

test("progressive replacement and resume restore convolution at the final transport frame",async()=>{
  const port=18769;
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
    const result=await page.evaluate(async()=>{
      const {createPreviewPlayer}=await import("/src/preview-player.mjs");
      const ctx=new AudioContext();await ctx.resume();
      const restored=[],bridges=[],seekTargets=[];
      const source={sourceFrames:480000,channelCount:1,sampleRate:48000,maxReadFrames:1024,
        async read(start,count){return {startFrame:start,channels:[new Float32Array(count)]};},dispose(){}};
      const bridgeFactory=async({ctx,startFrame,onEvent})=>{
        const node=ctx.createGain();let frame=startFrame,running=false;
        node.processingMode="raw";
        node.latest={sourceFrame:frame,outputTime:ctx.currentTime,running,ended:false};
        node.seek=async target=>{frame=target;seekTargets.push(target);node.latest={sourceFrame:frame,outputTime:ctx.currentTime,running,ended:false};return {sourceFrame:frame};};
        node.play=async()=>{running=true;frame=Math.min(source.sourceFrames,frame+12000);
          node.latest={sourceFrame:frame,outputTime:ctx.currentTime,running,ended:false};
          onEvent({type:"render-applied",sourceFrame:frame,outputTime:ctx.currentTime,running:true,missingFramesInBlock:0});
          return {sourceFrame:frame};};
        node.pause=async()=>{running=false;node.latest={sourceFrame:frame,outputTime:ctx.currentTime,running,ended:false};return {sourceFrame:frame};};
        node.dispose=()=>{};bridges.push(node);return node;
      };
      const restore=async(_ctx,_source,_ir,targetFrame)=>{
        restored.push(targetFrame);
        return targetFrame===0?null:{startFrame:targetFrame,sampleRate:ctx.sampleRate,channels:[Float32Array.of(.1)]};
      };
      const player=createPreviewPlayer(ctx,{createBridge:bridgeFactory,restoreHistory:restore});
      const signal={source,sourceFrames:source.sourceFrames,sampleRate:source.sampleRate,mode:"normal",
        ir:{origin:0,sampleRate:ctx.sampleRate,channels:[Float32Array.of(.5,.25)]},mix:.5,solo:"mix",predelay:0};
      await player.load(signal,1,{frame:0,resume:true,reset:true});
      const replacement={...signal,ir:{...signal.ir,channels:[Float32Array.of(.25,.125)]}};
      await player.load(replacement,1,{frame:0,resume:true,reset:true,crossfade:true});
      const replacementFrame=player.state.position;
      const beforePause=bridges.length;
      await player.pause();const pauseFrame=player.state.position;
      const readsBeforeResume=restored.length;
      await player.play();
      const result={restored,seekTargets,replacementFrame,pauseFrame,readsBeforeResume,
        readsAfterResume:restored.length,bridgesBeforePause:beforePause,bridgesAfterResume:bridges.length,
        resumedFrame:player.state.position};
      player.dispose();await ctx.close();return result;
    });
    assert.ok(result.replacementFrame>0,JSON.stringify(result));
    assert.equal(result.restored[1],result.seekTargets[0],"replacement history must follow the bridge's actual seek position");
    assert.equal(result.bridgesAfterResume,result.bridgesBeforePause+1,"resume must rebuild the live convolution route");
    assert.equal(result.restored.at(-1),result.pauseFrame,"resume history must start at the accepted pause frame");
    assert.ok(result.readsAfterResume>result.readsBeforeResume,JSON.stringify(result));
    assert.ok(result.resumedFrame>result.pauseFrame,JSON.stringify(result));
  }finally{await cleanupTestProcesses(browser,[server]);}
});
