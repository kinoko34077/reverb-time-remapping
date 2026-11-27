import test from "node:test";
import assert from "node:assert/strict";
import {renderIRSpectral,renderSpectralWet} from "../src/ir-spectral.mjs";
import {referenceConvolution} from "./helpers/time-reference.mjs";

const sr=48000;
const impulse=(channels)=>({sampleRate:sr,origin:0,channels:channels.map(c=>Float32Array.from(c))});
const tone=(n=48000)=>{
  const l=Float32Array.from({length:n},(_,i)=>.25*Math.sin(2*Math.PI*440*i/sr));
  return {sampleRate:sr,origin:0,channels:[l,l.map(v=>-v)]};
};
const rms=a=>Math.sqrt(a.reduce((s,v)=>s+v*v,0)/a.length);
function energy(a,hz){
  let r=0,j=0;for(let i=0;i<a.length;i++){
    const p=2*Math.PI*hz*i/sr;r+=a[i]*Math.cos(p);j+=a[i]*Math.sin(p);
  }return Math.hypot(r,j);
}
test("ordinary scan exact, even for sparse reflections and unequal amplitudes",()=>{
  const h=impulse([[1,0,-.125,0,.25],[0,-1,0,.5,.125]]);
  const normal=renderIRSpectral(h);
  assert.deepEqual(normal.channels,h.channels);
  assert.notEqual(normal.channels[0],h.channels[0]);
  assert.equal(normal.trajectory.algorithm,"exact-raw");
  const partial=renderIRSpectral(h,{startFrame:3,outputFrames:4});
  assert.deepEqual(Array.from(partial.channels[0]),[0,.25,0,0]);
  assert.equal(partial.trajectory.renderedFrames,2);
});
test("frozen and signed IR age trajectories retain carrier and stereo polarity",()=>{
  const h=tone();
  for(const speed of [0,.5,-1,2]){
    const k=renderIRSpectral(h,{startFrame:18000,speed,outputFrames:8192});
    const left=k.channels[0].subarray(2048),right=k.channels[1].subarray(2048);
    assert.ok(rms(left)>.04,{speed,rms:rms(left)});
    assert.ok(energy(left,440)>3*Math.max(energy(left,220),energy(left,880)),{speed});
    assert.ok(left.every((v,i)=>Math.abs(v+right[i])<1e-5),{speed});
    assert.equal(k.trajectory.endFrame,18000+8192*speed);
    assert.match(k.trajectory.algorithm,/phase-vocoder/);
  }
});
test("late local IR state retains decay relative to early state without normalization",()=>{
  const n=48000,l=Float32Array.from({length:n},(_,i)=>(i<n/2?.3:.03)*Math.sin(2*Math.PI*440*i/sr));
  const ir={sampleRate:sr,channels:[l]};
  const early=renderIRSpectral(ir,{startFrame:12000,speed:0,outputFrames:8192});
  const late=renderIRSpectral(ir,{startFrame:36000,speed:0,outputFrames:8192});
  const ratio=rms(late.channels[0].subarray(2048))/rms(early.channels[0].subarray(2048));
  assert.ok(Math.abs(ratio-.1)<.005,{ratio});
});
test("finite zero boundary, repeat and invalid size/trajectory",()=>{
  const ir=tone(8192);
  const end=renderIRSpectral(ir,{startFrame:2,speed:-1,outputFrames:128});
  assert.equal(end.trajectory.renderedFrames,3);
  assert.ok(end.channels.every(c=>c.subarray(3).every(v=>v===0)));
  const repeat=renderIRSpectral(ir,{startFrame:4000,speed:2,boundary:"repeat",
    loopStartFrame:3000,loopEndFrame:5000,outputFrames:4096});
  assert.equal(repeat.trajectory.renderedFrames,4096);
  assert.equal(repeat.trajectory.endFrame,4192);
  assert.throws(()=>renderIRSpectral(ir,{outputFrames:0}));
  assert.throws(()=>renderIRSpectral(ir,{outputFrames:100000,maxBytes:64}));
  assert.throws(()=>renderIRSpectral(ir,{speed:9}));
  assert.throws(()=>renderIRSpectral(ir,{startFrame:0,boundary:"repeat",loopStartFrame:1}));
});
test("reconstructed IR is the actual convolution kernel with signed placement",async()=>{
  const ir=tone(8192),input=impulse([[1]]);
  const mono=async(x,h)=>Float32Array.from(referenceConvolution(x,h).samples);
  const result=await renderSpectralWet(input,ir,{startFrame:4096,speed:0,outputFrames:4096},
    {delay:-20,renderMono:mono});
  assert.equal(result.wet.origin,-20);
  assert.deepEqual(result.wet.channels,result.kernel.channels);
  assert.equal(result.wet.channels[0].length,4096);
});
