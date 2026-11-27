import test from "node:test";
import assert from "node:assert/strict";
import {renderConvolution,comparisonInterval,alignPCM,mixAligned,previewGain,secondsToFrames} from "../src/convolution.mjs";
import {referenceConvolution} from "./helpers/time-reference.mjs";
const signal=(channels,origin=0,sampleRate=48000)=>({channels:channels.map(c=>Float32Array.from(c)),origin,sampleRate});
const mono=async(x,h)=>Float32Array.from(referenceConvolution(x,h).samples);
test("R2 routing: 1x1, 1x2, 2x1 and 2x2 with both placements",async()=>{
  for(const input of [[[1,2]],[[1,2],[-2,1]]])for(const ir of [[[2,-1,3]],[[2,-1,3],[-1,3,2]]])
    for(const reverse of [false,true])for(const delay of [-2,0,3]){
      const result=await renderConvolution(signal(input,5),signal(ir),{delay,reverse,renderMono:mono});
      const count=Math.max(input.length,ir.length);
      assert.equal(result.channels.length,count);
      for(let c=0;c<count;c++){
        const expected=referenceConvolution(input[input.length===1?0:c],ir[ir.length===1?0:c],{delay,reverse});
        assert.equal(result.origin,5+expected.origin);
        assert.deepEqual(Array.from(result.channels[c]),Array.from(expected.samples));
      }
    }
});
test("R2 common interval, aligned endpoint mix and separate preview gain",async()=>{
  const x=signal([[1,2]]),h=signal([[2,3,4],[1,-1,2]]),delay=-2;
  const interval=comparisonInterval(x,h,delay);
  assert.deepEqual(interval,{start:-4,end:2});
  const y=await renderConvolution(x,h,{delay,renderMono:mono});
  const dry=alignPCM(x,{...interval,channelCount:2});
  const wet=alignPCM(y,{...interval,channelCount:2});
  assert.deepEqual(mixAligned(dry,wet,0),dry);
  assert.deepEqual(mixAligned(dry,wet,1),wet);
  const gain=previewGain([dry,wet],1,.9);
  assert.ok(gain.applied<1);assert.ok(gain.peak*gain.applied<=.90000000001);
  assert.equal(y.channels[0][0],2,"no implicit IR normalization");
});
test("R2 invalid layouts and memory limit fail before native work",async()=>{
  const x=signal([[1]]),h=signal([[1,2]]);
  let calls=0;const backend=async()=>{calls++;return new Float32Array(2);};
  await assert.rejects(renderConvolution(x,signal([[1]],0,44100),{renderMono:backend}),/same sample/);
  await assert.rejects(renderConvolution(x,signal([[1],[2],[3],[4]]),{renderMono:backend}),/mono\/stereo/);
  await assert.rejects(renderConvolution(x,signal([[NaN]]),{renderMono:backend}),/finite/);
  await assert.rejects(renderConvolution(x,h,{maxBytes:8,renderMono:backend}),/budget/);
  assert.equal(calls,0);
  assert.throws(()=>alignPCM(x,{start:-10000,end:10000,channelCount:1,maxBytes:8}),/budget/);
  assert.equal(secondsToFrames(-.0005,1000),-1);
  assert.equal(secondsToFrames(.0005,1000),1);
});
