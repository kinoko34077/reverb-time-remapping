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

// Acoustic proxies for this finite IR approximation, not physical path recovery.
// Measurements are separate from the production STFT to avoid testing it with itself.
test("IR spectral multiband, window-size and loop periodicity measurements",()=>{
  const n=48000,center=24000;
  const low=375,high=1500;
  const signal=Float32Array.from({length:n},(_,i)=>.3*Math.sin(2*Math.PI*low*i/sr)+.12*Math.sin(2*Math.PI*high*i/sr));
  const ir={sampleRate:sr,channels:[signal,signal.map(v=>-v)]};
  const reference=signal.subarray(center,center+4096),ratio=energy(reference,high)/energy(reference,low);
  const measurements=[];
  for(const fftFrames of [1024,2048,4096]){
    for(const speed of [0,-.5,2]){
      const k=renderIRSpectral(ir,{startFrame:center,speed,outputFrames:8192,fftFrames,hopFrames:fftFrames/8});
      const l=k.channels[0].subarray(4096),r=k.channels[1].subarray(4096);
      const bandRatio=energy(l,high)/energy(l,low);
      const relativePhaseError=Math.max(...l.map((v,i)=>Math.abs(v+r[i])));
      measurements.push({fftFrames,speed,rms:rms(l),bandRatio,referenceRatio:ratio,relativePhaseError});
      assert.ok(rms(l)>.05);
      assert.ok(Math.abs(bandRatio-ratio)<.12,{fftFrames,speed,bandRatio,ratio});
      assert.ok(relativePhaseError<1e-5);
    }
  }
  // A non-bin-centered tone distinguishes local PCM repetition from phase
  // propagation. Periodicity proxy is the normalized difference at one window lag.
  const h=tone(),k=renderIRSpectral(h,{startFrame:center,speed:0,outputFrames:8192});
  const grain=h.channels[0].slice(center-1024,center+1024);
  const raw=Float32Array.from({length:4096},(_,i)=>grain[i%grain.length]);
  const pv=k.channels[0].subarray(4096);
  const lagError=x=>rms(Float32Array.from(x.subarray(0,2048),(v,i)=>v-x[i+2048]))/rms(x);
  const rawError=lagError(raw),pvError=lagError(pv);
  assert.equal(rawError,0);assert.ok(pvError>.05,{pvError});
  console.log("R4 acoustic band/phase and lag proxies",JSON.stringify({measurements,rawError,pvError}));
});
test("IR spectral sparse-reflection smearing is measured rather than treated as path recovery",()=>{
  const n=16384,l=new Float32Array(n);
  l[4096]=1;l[8192]=.3;l[12288]=.1;
  const h={sampleRate:sr,channels:[l,l.map(v=>-v)]};
  const stats=x=>{
    const powers=Array.from(x,v=>v*v),total=powers.reduce((s,v)=>s+v,0);
    let sum=0,a=null,b=null,active=0,peak=0;
    for(let i=0;i<x.length;i++){
      sum+=powers[i];if(a===null&&sum>=.05*total)a=i;if(b===null&&sum>=.95*total)b=i;
      peak=Math.max(peak,Math.abs(x[i]));
    }
    for(let i=0;i<x.length;i+=128)if(rms(x.subarray(i,i+128))>peak*.005)active++;
    return {rms:rms(x),peak,energyWidthFrames:total?b-a:0,activeBlocks:active};
  };
  const exact=renderIRSpectral(h),original=stats(l);
  assert.deepEqual(exact.channels[0],l);assert.equal(original.activeBlocks,3);
  const measurements=[];
  for(const fftFrames of [1024,2048,4096]){
    const k=renderIRSpectral(h,{startFrame:4096,speed:0,outputFrames:8192,fftFrames,hopFrames:fftFrames/8});
    const left=k.channels[0],right=k.channels[1],m=stats(left);
    assert.ok(left.every(Number.isFinite));assert.ok(left.every((v,i)=>Math.abs(v+right[i])<1e-5));
    assert.ok(m.rms>0&&m.peak>0&&m.activeBlocks>1);
    measurements.push({fftFrames,...m});
  }
  console.log("R4 sparse reflection energy-spread proxies",JSON.stringify({original,measurements}));
});

test("IR spectral pingpong maps only analysis centers in original IR context",()=>{
  const h=tone(),center=24000,outputFrames=8192;
  const hold=renderIRSpectral(h,{startFrame:center,speed:0,outputFrames});
  const one=renderIRSpectral(h,{startFrame:center,speed:8,outputFrames,boundary:"pingpong",
    loopStartFrame:center,loopEndFrame:center+1});
  assert.deepEqual(one.channels,hold.channels);
  assert.equal(one.trajectory.endFrame,center);
  const a=center-200,b=center+201,span=b-a-1,period=2*span;
  for(const speed of [-1,.5,2]){
    const k=renderIRSpectral(h,{startFrame:center,speed,outputFrames,boundary:"pingpong",loopStartFrame:a,loopEndFrame:b});
    const u=((center-a+outputFrames*speed)%period+period)%period;
    assert.equal(k.trajectory.endFrame,a+Math.min(u,period-u));
    assert.equal(k.trajectory.renderedFrames,outputFrames);
    const l=k.channels[0].subarray(2048),r=k.channels[1].subarray(2048);
    assert.ok(rms(l)>.04);assert.ok(energy(l,440)>3*Math.max(energy(l,220),energy(l,880)));
    assert.ok(l.every((v,i)=>Math.abs(v+r[i])<1e-5));
  }
  assert.throws(()=>renderIRSpectral(h,{startFrame:center,boundary:"pingpong",loopStartFrame:center+1}),/outside repeat/);
});
