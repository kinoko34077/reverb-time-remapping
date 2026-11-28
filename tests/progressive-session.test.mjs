import test from "node:test";
import assert from "node:assert/strict";
import {createProgressiveSession} from "../src/progressive-session.mjs";

test("progressive IR Window slices the kernel without shortening the source timeline",async()=>{
  const source={sourceFrames:500_000,channelCount:2,sampleRate:48_000,
    async read(){throw Error("IR selection must not read the full source");}};
  const ir={origin:0,sampleRate:48_000,channels:[
    Float32Array.from({length:128},(_,i)=>i/128),
    Float32Array.from({length:128},(_,i)=>-i/128)
  ]};
  const session=createProgressiveSession(source,ir,{irWindowSettings:{start:.001,duration:.0015,calibration:"natural"}});
  const normal=session.select("normal"),window=session.select("ir-window");
  assert.equal(session.length,source.sourceFrames);
  assert.equal(window.sourceFrames,source.sourceFrames);
  assert.equal(normal.ir.channels[0].length,128);
  assert.equal(window.ir.channels[0].length,72);
  assert.equal(session.irWindow.startFrame,48);
  assert.equal(session.irWindow.endFrame,120);
  assert.deepEqual(Array.from(window.ir.channels[0]),Array.from(ir.channels[0].slice(48,120)));
  assert.deepEqual(Array.from(window.ir.channels[1]),Array.from(ir.channels[1].slice(48,120)));
  const moved=await session.withIRWindow({start:.0005,duration:.001,calibration:"natural"});
  assert.equal(moved.irWindow.startFrame,24);
  assert.equal(moved.irWindow.endFrame,72);
  assert.equal(moved.length,session.length);
});

test("progressive preview gain bounds both Normal and compensated IR Window convolution",()=>{
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
  assert.equal(session.select("normal").ir.channels[0],samples);
  assert.equal(session.select("ir-window").ir.channels[0].length,10_000);
});
