import test from "node:test";
import assert from "node:assert/strict";
import {createProgressiveSession} from "../src/progressive-session.mjs";
import {matchKernelSampleRate} from "../src/progressive-convolution.mjs";
import {referenceConvolution,sampleAt} from "./helpers/time-reference.mjs";

test("progressive Reverse reader renders signed output windows from bounded source reads",async()=>{
  const input=Float32Array.from([1,.5,-.25,.75,0,.1,-.2,.4, .3,-.1,.2,.8,-.5,.6,.25,-.3]);
  const impulse=Float32Array.from([.2,-.4,.8,.1]);
  const reads=[];
  const source={sourceFrames:input.length,channelCount:1,sampleRate:48_000,maxReadFrames:4,
    async read(startFrame,frameCount){reads.push([startFrame,frameCount]);
      return {startFrame,channels:[input.slice(startFrame,startFrame+frameCount)]};}};
  const timelineReference=referenceConvolution(input,impulse,{delay:1,reverse:true});
  const session=createProgressiveSession(source,{origin:0,sampleRate:48_000,channels:[impulse]},
    {predelay:1/48_000,reverseReaderOptions:{windowFrames:4,maxReadFrames:4,renderWindow:async request=>{
      const result=[new Float32Array(request.frameCount)];
      for(let frame=0;frame<request.frameCount;frame++){
        const time=request.outputStart+frame;
        for(let sourceFrame=request.required.start;sourceFrame<request.required.end;sourceFrame++){
          const irFrame=sourceFrame+request.delayFrames-time;
          if(irFrame>=0&&irFrame<request.kernel.channels[0].length)
            result[0][frame]+=request.input[0][sourceFrame-request.required.start]*request.kernel.channels[0][irFrame];
        }
      }
      return result;
    }}});
  const signal=await session.select("reverse",1,"wet");
  assert.equal(signal.sourceFrames,session.outputFor("reverse").timeline.length);
  const actual=[];
  for(let start=0;start<signal.sourceFrames;start+=4){
    const count=Math.min(4,signal.sourceFrames-start);
    const block=await signal.source.read(start,count,{priority:"playback"});
    actual.push(...block.channels[0]);
  }
  assert.equal(signal.output.timeline.start,timelineReference.origin);
  const expected=Array.from({length:signal.sourceFrames},(_,i)=>sampleAt(timelineReference,signal.output.timeline.start+i));
  assert.ok(actual.every((value,index)=>Math.abs(value-expected[index])<1e-6));
  assert.ok(reads.every(([,count])=>count<=source.maxReadFrames),JSON.stringify(reads));
  assert.ok(signal.source.stats().residentWindows<=2);
  await session.select("reverse",0,"dry");
  const dry=[];
  for(let start=0;start<signal.sourceFrames;start+=4){
    const count=Math.min(4,signal.sourceFrames-start);
    dry.push(...(await signal.source.read(start,count,{priority:"playback"})).channels[0]);
  }
  const expectedDry=Array.from({length:signal.sourceFrames},(_,i)=>{
    const sourceFrame=signal.output.timeline.start+i;
    return sourceFrame>=0&&sourceFrame<input.length?input[sourceFrame]:0;
  });
  assert.deepEqual(dry,expectedDry);
  await session.select("reverse",.5,"mix");
  const mixed=await signal.source.read(0,4,{priority:"playback"});
  assert.ok(mixed.channels[0].every((value,index)=>Math.abs(value-(actual[index]+expectedDry[index])/2)<1e-6),
    JSON.stringify({mixed:[...mixed.channels[0]],actual:actual.slice(0,4),dry:expectedDry.slice(0,4)}));
  session.dispose();
});

test("progressive Reverse cache is disposed when its session is replaced",async()=>{
  const source={sourceFrames:16,channelCount:1,sampleRate:48_000,maxReadFrames:4,
    async read(startFrame,frameCount){return {startFrame,channels:[new Float32Array(frameCount)]};}};
  const ir={origin:0,sampleRate:48_000,channels:[Float32Array.from([1,.5,.25])]};
  const session=createProgressiveSession(source,ir,{reverseReaderOptions:{windowFrames:4,maxReadFrames:4,
    renderWindow:async request=>[new Float32Array(request.frameCount)]}});
  const reverse=await session.select("reverse");
  const replacement=await session.withIRWindow({start:0,duration:1/48_000,calibration:"natural"});
  session.dispose();
  await assert.rejects(reverse.source.read(0,1,{priority:"playback"}),/disposed/);
  replacement.dispose();
});

test("progressive Reverse timeline retains the full Dry source under long predelay",async()=>{
  const input=Float32Array.from({length:16},(_,i)=>(i+1)/32);
  const source={sourceFrames:input.length,channelCount:1,sampleRate:48_000,maxReadFrames:4,
    async read(startFrame,frameCount){return {startFrame,channels:[input.slice(startFrame,startFrame+frameCount)]};}};
  const ir={origin:0,sampleRate:48_000,channels:[Float32Array.from([.2,-.4,.8,.1])]};
  const session=createProgressiveSession(source,ir,{predelay:8/48_000,
    reverseReaderOptions:{windowFrames:4,maxReadFrames:4,renderWindow:async request=>[new Float32Array(request.frameCount)]}});
  const output=session.outputFor("reverse");
  assert.equal(output.timeline.start,0);
  assert.equal(output.timeline.end,input.length+8);
  const signal=await session.select("reverse",0,"dry");
  const dry=[];
  for(let start=0;start<input.length;start+=4)
    dry.push(...(await signal.source.read(start,Math.min(4,input.length-start),{priority:"playback"})).channels[0]);
  assert.deepEqual(Float32Array.from(dry),input);
  session.dispose();

  const negative=createProgressiveSession(source,ir,{predelay:-8/48_000,
    reverseReaderOptions:{windowFrames:4,maxReadFrames:4,renderWindow:async request=>[new Float32Array(request.frameCount)]}});
  const negativeOutput=negative.outputFor("reverse"),negativeStart=-negativeOutput.timeline.start;
  assert.equal(negativeOutput.timeline.start,-11);
  assert.equal(negativeOutput.timeline.end,input.length);
  const negativeSignal=await negative.select("reverse",0,"dry");
  const negativeDry=[];
  for(let offset=0;offset<input.length;offset+=4)
    negativeDry.push(...(await negativeSignal.source.read(negativeStart+offset,Math.min(4,input.length-offset),
      {priority:"playback"})).channels[0]);
  assert.deepEqual(Float32Array.from(negativeDry),input);
  negative.dispose();
});

test("progressive Reverse matches convolution amplitude to the shared processing clock",async()=>{
  class OfflineContext{
    constructor(channels,frames,sampleRate){this.channels=channels;this.frames=frames;this.sampleRate=sampleRate;this.destination={};}
    createBuffer(){return {copyToChannel(){}};}
    createBufferSource(){return {connect(){},start(){}};}
    async startRendering(){return {getChannelData:()=>new Float32Array(this.frames).fill(.5)};}
  }
  const source={sourceFrames:8,channelCount:1,sampleRate:96_000,maxReadFrames:8,
    async read(startFrame,frameCount){return {startFrame,channels:[new Float32Array(frameCount).fill(1)]};}};
  const ir={origin:0,sampleRate:44_100,channels:[Float32Array.of(1)]};
  let reverseKernel;
  const session=createProgressiveSession(source,ir,{processingRate:48_000,
    reverseReaderOptions:{Context:OfflineContext,windowFrames:4,maxReadFrames:8,
      renderWindow:async request=>{reverseKernel=request.kernel;return [new Float32Array(request.frameCount)];}}});
  const signal=await session.select("reverse",1,"wet");
  await signal.source.read(0,1,{priority:"playback"});
  const expected=await matchKernelSampleRate({sampleRate:48_000},ir,{Context:OfflineContext});
  assert.equal(reverseKernel.sampleRate,source.sampleRate);
  assert.ok(Math.abs(reverseKernel.channels[0][0]-expected.channels[0][0])<1e-6,
    JSON.stringify({actual:reverseKernel.channels[0][0],expected:expected.channels[0][0]}));
  session.dispose();
});

test("progressive IR Window slices the kernel without shortening the source timeline",async()=>{
  const source={sourceFrames:500_000,channelCount:2,sampleRate:48_000,
    async read(){throw Error("IR selection must not read the full source");}};
  const ir={origin:0,sampleRate:48_000,channels:[
    Float32Array.from({length:128},(_,i)=>i/128),
    Float32Array.from({length:128},(_,i)=>-i/128)
  ]};
  const session=createProgressiveSession(source,ir,{irWindowSettings:{start:.001,duration:.0015,calibration:"natural"}});
  const [normal,window]=await Promise.all([session.select("normal"),session.select("ir-window")]);
  assert.equal(session.length,source.sourceFrames);
  assert.equal(window.sourceFrames,source.sourceFrames);
  assert.equal(normal.ir.channels[0].length,128);
  assert.equal(window.ir.channels[0].length,72);
  assert.equal(normal.output.timeline.length,session.wetOutputFrames);
  const reverse=session.outputFor("reverse");
  assert.equal(reverse.timeline.start,-127);
  assert.equal(reverse.timeline.end,source.sourceFrames);
  assert.deepEqual(reverse.requiredSourceRange(0,64),{
    start:0,end:64,lookaheadFrames:127,tailFrames:0
  });
  assert.deepEqual(reverse.requiredSourceRange(reverse.timeline.length-64,64),{
    start:499_936,end:500_000,lookaheadFrames:127,tailFrames:0
  });
  assert.equal(session.irWindow.startFrame,48);
  assert.equal(session.irWindow.endFrame,120);
  assert.deepEqual(Array.from(window.ir.channels[0]),Array.from(ir.channels[0].slice(48,120)));
  assert.deepEqual(Array.from(window.ir.channels[1]),Array.from(ir.channels[1].slice(48,120)));
  const moved=await session.withIRWindow({start:.0005,duration:.001,calibration:"natural"});
  assert.equal(moved.irWindow.startFrame,24);
  assert.equal(moved.irWindow.endFrame,72);
  assert.equal(moved.length,session.length);
  assert.equal(moved.outputFor("ir-window").irFrames,48);
  assert.deepEqual(moved.outputFor("ir-window").requiredSourceRange(30,1),{
    start:0,end:31,lookaheadFrames:0,tailFrames:47
  });
});

test("progressive preview gain bounds both Normal and compensated IR Window convolution",async()=>{
  const source={sourceFrames:3*48_000,channelCount:2,sampleRate:48_000,async read(){}};
  const samples=new Float32Array(100_000);
  samples[0]=10;
  samples.fill(.001,90_000);
  const session=createProgressiveSession(source,{origin:0,sampleRate:48_000,channels:[samples]},
    {irWindowSettings:{start:90_000/48_000,duration:10_000/48_000,calibration:"compensated"}});
  assert.equal(session.irScale,8);
  assert.ok(session.gain.peak>=80,JSON.stringify(session.gain));
  assert.ok(session.gain.applied*session.gain.peak<=session.gain.ceiling,JSON.stringify(session.gain));
  assert.ok(session.gain.applied<.25,JSON.stringify(session.gain));
  assert.equal((await session.select("normal")).ir.channels[0],samples);
  assert.equal((await session.select("ir-window")).ir.channels[0].length,10_000);
  const resampled=session.withProcessingRate(96_000);
  assert.equal(resampled.processingRate,96_000);
  assert.ok(resampled.gain.peak>=160,JSON.stringify(resampled.gain));
  assert.ok(resampled.gain.applied*resampled.gain.peak<=resampled.gain.ceiling,JSON.stringify(resampled.gain));
});
