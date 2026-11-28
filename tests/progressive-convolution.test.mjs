import test from "node:test";
import assert from "node:assert/strict";
import {matchKernelSampleRate} from "../src/progressive-convolution.mjs";

test("resampling a convolution kernel preserves its continuous-time area",async()=>{
  class OfflineContext{
    constructor(channels,frames,sampleRate){this.channels=channels;this.frames=frames;this.sampleRate=sampleRate;this.destination={};}
    createBuffer(){return {copyToChannel(){}};}
    createBufferSource(){return {connect(){},start(){}};}
    async startRendering(){
      return {getChannelData:()=>new Float32Array(this.frames).fill(.5)};
    }
  }
  const result=await matchKernelSampleRate({sampleRate:48_000},
    {origin:0,sampleRate:44_100,channels:[Float32Array.of(1)]},{Context:OfflineContext});
  assert.equal(result.sampleRate,48_000);
  assert.ok(Math.abs(result.channels[0][0]-.5*(48_000/44_100))<1e-6,
    String(result.channels[0][0]));
});
