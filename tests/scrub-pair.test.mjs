import test from "node:test";
import assert from "node:assert/strict";
import {axisPlan,scrubGains,isScrubMode} from "../src/scrub-pair.mjs";

test("raw freeze keeps the reference anchor and loops a finite local carrier",()=>{
  const p=axisPlan({frame:10000,speed:0},48000,48000,"raw");
  assert.deepEqual(p,{anchor:10000,frame:10000,speed:1,a:8800,b:11200,loop:true,frozen:true});
  const edge=axisPlan({frame:48000,speed:0},48000,48000,"raw");
  assert.equal(edge.anchor,47999);assert.equal(edge.b,48000);assert.equal(edge.a,45600);
  const small=axisPlan({frame:0,speed:0},4,48000,"raw");
  assert.equal(small.b,4);
});
test("PV freeze and signed repeat retain the independent clock semantics",()=>{
  const p=axisPlan({frame:10000,speed:0},48000,48000,"pv");
  assert.equal(p.speed,0);assert.equal(p.anchor,10000);assert.equal(p.loop,false);
  const reverse=axisPlan({frame:48000,speed:-2,repeat:true},48000,48000,"pv");
  assert.equal(reverse.frame,47999);assert.equal(reverse.speed,-2);assert.equal(reverse.loop,true);
  assert.throws(()=>axisPlan({frame:2,speed:9},48000,48000,"pv"));
  assert.throws(()=>axisPlan({frame:-1,speed:1},48000,48000,"raw"));
});
test("Wet independent comparison has explicit solo and bounded linear gains",()=>{
  assert.deepEqual(scrubGains(.75,"mix"),[.25,.75]);
  assert.deepEqual(scrubGains(.75,"dry"),[1,0]);
  assert.deepEqual(scrubGains(.75,"wet"),[0,1]);
  assert.throws(()=>scrubGains(2,"mix"));
  assert.ok(isScrubMode("wet-buffer")&&isScrubMode("wet-spectral")&&!isScrubMode("normal"));
});
