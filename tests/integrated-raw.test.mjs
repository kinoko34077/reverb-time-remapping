import test from "node:test";
import assert from "node:assert/strict";
import {renderIntegratedRaw} from "../src/integrated-raw.mjs";
import {integratedRaw,referenceConvolution,sampleAt} from "./helpers/time-reference.mjs";
const sr=48000,pcm=(channels,origin=0)=>({sampleRate:sr,origin,channels:channels.map(c=>Float32Array.from(c))});
const close=(a,b)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<=1e-6*Math.max(1,Math.abs(b[i])),{i,actual:a[i],expected:b[i]});};
test("integrated raw ordinary clock matches convolution and signed placements",()=>{
  const x=pcm([[1,0,.5,-.25],[.2,0,-1,.1]],2),h=pcm([[1,.2,-.3]]);
  for(const delay of [-4,0,3]){
    const clockOrigin=-4,clock=Float64Array.from({length:20},(_,i)=>clockOrigin+i);
    const result=renderIntegratedRaw(x,h,clock,{clockOrigin,delay});
    assert.equal(result.origin,clockOrigin);
    for(let c=0;c<2;c++){
      const expected=referenceConvolution(x.channels[c],h.channels[0],{delay:x.origin+delay});
      close(result.channels[c],Float64Array.from(clock,n=>sampleAt(expected,n)));
    }
  }
});
test("existing tail can be held, rewound and advanced after input stops; new excitation has new anchor",()=>{
  const x=pcm([[1,0,2]]),h=pcm([[1,2,4]]);
  const clock=Float64Array.of(0,1,1,1,0,1,2,3,1);
  const result=renderIntegratedRaw(x,h,clock);
  assert.deepEqual(Array.from(result.channels[0]),[1,2,4,4,1,4,8,8,4]);
  const reference=integratedRaw(x.channels[0],h.channels[0],clock);
  close(result.channels[0],reference.samples);
  assert.equal(result.history.excitations,2);
  assert.equal(result.stats.retainedGroups,2);
  // Rendering only a later range must still recover the prior anchors.
  const tail=renderIntegratedRaw(x,h,clock,{start:4,count:5});
  assert.deepEqual(tail.channels[0],result.channels[0].slice(4));
});
test("fractional arbitrary clock, stereo and all range boundaries match independent oracle",()=>{
  const x=pcm([[.3,0,1,-.5,.2]],-2);
  const h=pcm([[.2,1,-.4,.2,.8],[-.2,-1,.4,-.2,-.8]]);
  const clockOrigin=-4,clock=Float64Array.of(0,1.5,1.5,-.5,0,3.25,2.5,2.5,-2,1,6,5.5,0,1);
  for(const boundary of ["zero","repeat","pingpong"]){
    for(const [lo,hi] of [[0,5],[1,4],[2,3]]){
      const options={clockOrigin,start:-1,count:9,delay:-1,range:{lo,hi,boundary}};
      const result=renderIntegratedRaw(x,h,clock,options);
      for(let c=0;c<2;c++)close(result.channels[c],integratedRaw(x.channels[0],h.channels[c],clock,{...options,inputOrigin:x.origin}).samples);
      assert.ok(result.channels[0].every((v,i)=>Math.abs(v+result.channels[1][i])<1e-6));
    }
  }
});
test("equal raw anchors group exactly, not input × IR allocation; finite history/work rejection",()=>{
  const x=pcm([Array(64).fill(.125)]),h=pcm([[.5,1]]);
  const clock=new Float64Array(128);
  const result=renderIntegratedRaw(x,h,clock,{maxTerms:128});
  assert.equal(result.stats.peakGroups,1);assert.equal(result.stats.terms,128);
  assert.equal(result.channels[0][63],4);assert.equal(result.channels[0][127],4);
  assert.throws(()=>renderIntegratedRaw(x,h,clock,{clockOrigin:1}),/missing placement/);
  assert.throws(()=>renderIntegratedRaw(x,h,clock,{maxTerms:10}),/work budget/);
  assert.throws(()=>renderIntegratedRaw(x,h,clock,{maxBytes:8}),/budget/);
  assert.throws(()=>renderIntegratedRaw(x,h,Float64Array.of(0,NaN)),/finite clock/);
  assert.throws(()=>renderIntegratedRaw(pcm([[0]]),h,[0,,1]),/finite clock/);
  assert.throws(()=>renderIntegratedRaw(x,h,clock,{range:{lo:1,hi:1}}),/IR range/);
});
