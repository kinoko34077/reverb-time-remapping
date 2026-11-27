import test from "node:test";
import assert from "node:assert/strict";
import {referenceConvolution,sampleAt,reversePlaced,readIR,integratedRaw} from "./helpers/time-reference.mjs";

const values=s=>Array.from(s.samples);
test("T2 normal impulse and signed placement",()=>{
  const h=[1,-2,3];
  assert.deepEqual(values(referenceConvolution([1],h)),h);
  const y=referenceConvolution([2,1],h,{delay:-2});
  assert.equal(y.origin,-2);assert.deepEqual(values(y),[2,-3,4,3]);
  assert.equal(sampleAt(y,-3),0);assert.equal(sampleAt(y,2),0);
});
test("T2 reverse IR ends at each excitation plus signed delay",()=>{
  const y=referenceConvolution([2,1],[1,-2,3],{delay:-2,reverse:true});
  assert.equal(y.origin,-4);assert.deepEqual(values(y),[6,-1,0,1]);
  const impulse=referenceConvolution([1],[1,-2,3],{delay:5,reverse:true});
  assert.equal(impulse.origin,3);assert.equal(sampleAt(impulse,5),1);
});
test("T2 reverse both unequal supports on the same signed coordinate",()=>{
  const dry={origin:0,samples:new Float64Array([1,2,3])};
  const wet=referenceConvolution(dry.samples,[1,2,3,4],{delay:-1});
  const start=-1,end=5;
  const a=reversePlaced(dry,start,end),b=reversePlaced(wet,start,end);
  const sum=Array.from({length:end-start},(_,i)=>sampleAt(dry,start+i)+sampleAt(wet,start+i));
  assert.deepEqual(values(a).map((v,i)=>v+b.samples[i]),sum.reverse());
  assert.throws(()=>reversePlaced(wet,0,end),/cover/);
});
test("T3 ordinary age clock is ordinary signed convolution",()=>{
  const q=[2,0,-1,3],h=[1,0.5,-0.25],delay=-2;
  const expected=referenceConvolution(q,h,{delay});
  const clock=Array.from({length:expected.samples.length},(_,i)=>i+delay);
  const actual=integratedRaw(q,h,clock,{clockOrigin:delay,delay});
  assert.deepEqual(actual,expected);
});
test("T3 seek and age freeze preserve individual anchors, including new input",()=>{
  // p0,p2,p4; A(p) is 0,2,1, not a common single IR window.
  const q=[1,0,2,0,4],h=[10,20,30,40];
  const clock=[0,1,2,2,1,1,3,4];
  const y=integratedRaw(q,h,clock);
  assert.deepEqual(values(y),[10,20,50,50,60,60,200,220]);
});
test("T3 range boundaries and interpolation",()=>{
  const h=[99,10,20,30,99];
  const range={lo:1,hi:4};
  assert.equal(readIR(h,0,range),0);
  assert.equal(readIR(h,3.5,range),15);
  assert.equal(readIR(h,3.5,{...range,boundary:"repeat"}),20);
  assert.equal(readIR(h,0,{...range,boundary:"repeat"}),30);
  assert.equal(readIR(h,4,{...range,boundary:"pingpong"}),20);
  assert.equal(readIR(h,0,{...range,boundary:"pingpong"}),20);
  assert.equal(readIR(h,-100,{lo:2,hi:3,boundary:"pingpong"}),20);
});
test("T3 missing clock history is explicit",()=>{
  assert.throws(()=>integratedRaw([1],[1,2],[1,2],{clockOrigin:1}),/history/);
  assert.throws(()=>integratedRaw([1],[1,2],[1,2],{count:3}),/outside/);
});
