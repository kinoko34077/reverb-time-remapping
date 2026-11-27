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
