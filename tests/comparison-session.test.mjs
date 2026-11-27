import test from "node:test";
import assert from "node:assert/strict";
import {makeSource,makeIR,readLocalWav,SOURCE_TYPES,IR_TYPES} from "../src/materials.mjs";
import {prepareComparison} from "../src/comparison-session.mjs";
import {referenceConvolution} from "./helpers/time-reference.mjs";
const sr=48000,mono=async(x,h)=>Float32Array.from(referenceConvolution(x,h).samples);
test("generated fixtures are deterministic, finite and nonempty",()=>{
  for(const kind of SOURCE_TYPES){
    const x=makeSource(kind,{seconds:.1});
    assert.equal(x.channels[0].length,4800);
    assert.ok(x.channels[0].every(Number.isFinite));assert.ok(x.channels[0].some(v=>v!==0));
    assert.deepEqual(x,makeSource(kind,{seconds:.1}));
  }
  for(const kind of IR_TYPES){
    const h=makeIR(kind,{seconds:.1});
    assert.equal(h.channels.length,2);assert.ok(h.channels.every(c=>c.length===4800&&c.every(Number.isFinite)&&c.some(v=>v!==0)));
  }
});
test("common interval, Dry bypass, reverse origin and shared safe gain",async()=>{
  const x={sampleRate:sr,origin:0,channels:[Float32Array.of(1,2)]};
  const h={sampleRate:sr,origin:0,channels:[Float32Array.of(.5,.25),Float32Array.of(-.5,.25)]};
  const c=await prepareComparison(x,h,{predelay:-1/sr,renderMono:mono});
  assert.deepEqual(c.interval,{start:-2,end:2});
  assert.equal(c.select("dry",1),c.signals.dry);
  assert.equal(c.select("normal",.7,"wet"),c.signals.normal);
  assert.deepEqual(Array.from(c.signals.reverse.channels[0]),[.25,1,1,0]);
  assert.deepEqual(Array.from(c.select("normal",0).channels[0]),Array.from(c.signals.dry.channels[0]));
  assert.ok(c.gain.peak*c.gain.applied<=.900000000001);
  await assert.rejects(prepareComparison(x,h,{maxBytes:4,renderMono:mono}),/予算/);
});
function wav(){
  const a=new ArrayBuffer(48),d=new DataView(a),tag=(p,s)=>{for(let i=0;i<s.length;i++)d.setUint8(p+i,s.charCodeAt(i));};
  tag(0,"RIFF");d.setUint32(4,40,true);tag(8,"WAVE");tag(12,"fmt ");d.setUint32(16,16,true);
  d.setUint16(20,1,true);d.setUint16(22,1,true);d.setUint32(24,sr,true);d.setUint32(28,sr*2,true);
  d.setUint16(32,2,true);d.setUint16(34,16,true);tag(36,"data");d.setUint32(40,4,true);
  d.setInt16(44,16384,true);d.setInt16(46,-16384,true);return new Blob([a]);
}
test("local WAV reads original PCM with budget and invalid-file rejection",async()=>{
  const x=await readLocalWav(wav());
  assert.deepEqual(Array.from(x.channels[0]),[.5,-.5]);
  assert.equal(x.originalSampleRate,sr);
  await assert.rejects(readLocalWav(wav(),{maxBytes:4}),/予算/);
  await assert.rejects(readLocalWav(new Blob(["bad"])));
});

import {extractIRWindow} from "../src/ir-window.mjs";
test("IR window keeps natural attenuation, stereo and signed placement",async()=>{
  const ir={sampleRate:sr,origin:0,channels:[Float32Array.of(1,.5,.1,.05),Float32Array.of(-1,-.5,-.1,-.05)]};
  const input={sampleRate:sr,origin:0,channels:[Float32Array.of(1)]};
  const early=extractIRWindow(ir,{start:0,duration:2/sr});
  const late=extractIRWindow(ir,{start:2/sr,duration:2/sr});
  assert.deepEqual(Array.from(late.channels[0]),Array.from(ir.channels[0].slice(2)));
  assert.ok(Math.abs(late.channels[0][0]/early.channels[0][0]-.1)<1e-7);
  assert.equal(late.channels[1][0],-late.channels[0][0]);
  const c=await prepareComparison(input,ir,{predelay:-1/sr,renderMono:mono,irWindow:{start:2/sr,duration:2/sr}});
  const wet=c.select("ir-window",1,"wet"),offset=-1-c.interval.start;
  assert.deepEqual(Array.from(wet.channels[0].slice(offset,offset+2)),Array.from(late.channels[0]));
  assert.ok(wet.channels[0].slice(0,offset).every(v=>v===0));
  assert.ok(wet.channels[0].slice(offset+2).every(v=>v===0));
  assert.deepEqual(c.irWindow,{startFrame:2,endFrame:4,requestedFrames:2,truncated:false});
  assert.equal(extractIRWindow(ir,{start:3/sr,duration:4/sr}).range.truncated,true);
  assert.throws(()=>extractIRWindow(ir,{start:4/sr,duration:1/sr}),/範囲外/);
  assert.throws(()=>extractIRWindow(ir,{start:-1/sr,duration:1/sr}),/不正/);
});

test("IR window refresh reuses base signals and applies common RMS correction explicitly",async()=>{
  const x={sampleRate:sr,origin:0,channels:[Float32Array.of(1)]};
  const ir={sampleRate:sr,origin:0,channels:[Float32Array.of(1,1,.1,.1),Float32Array.of(-1,-1,-.1,-.1)]};
  const c=await prepareComparison(x,ir,{renderMono:mono,irWindow:{start:0,duration:2/sr}});
  const late=await c.withIRWindow({start:2/sr,duration:2/sr});
  for(const mode of ["dry","normal","reverse"])assert.equal(late.signals[mode],c.signals[mode]);
  assert.equal(late.irScale,1);
  const corrected=await late.withIRWindow({start:2/sr,duration:2/sr,calibration:"compensated"});
  assert.ok(Math.abs(corrected.irScale-Math.sqrt(.505)/.1)<1e-6);
  const l=corrected.signals["ir-window"].channels[0],r=corrected.signals["ir-window"].channels[1];
  assert.ok(l.every((v,i)=>v===-r[i]));
  const at=-corrected.interval.start;
  assert.ok(Math.abs(l[at]-Math.sqrt(.505))<1e-6);
  assert.ok(Math.abs(late.signals["ir-window"].channels[0][at]-.1)<1e-7);
  await assert.rejects(c.withIRWindow({start:9/sr,duration:1/sr}),/範囲外/);
  const weak={sampleRate:sr,channels:[Float32Array.of(1,1e-7,0)]};
  assert.equal(extractIRWindow(weak,{start:1/sr,duration:1/sr,calibration:"compensated"}).scale,8);
  const silent=extractIRWindow(weak,{start:2/sr,duration:1/sr,calibration:"compensated"});
  assert.equal(silent.scale,1);assert.equal(silent.channels[0][0],0);
});
