import test from "node:test";
import assert from "node:assert/strict";
import {axisPlan,axisSource,scrubGains,isScrubMode} from "../src/scrub-pair.mjs";

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

test("repeat bounds constrain only enabled loop and select signed endpoint",()=>{
  const bounds={rangeStartFrame:12000,rangeEndFrame:24000};
  assert.deepEqual(axisPlan({frame:30000,speed:1,repeat:true,...bounds},48000,48000,"raw"),
    {anchor:12000,frame:12000,speed:1,a:12000,b:24000,loop:true,frozen:false});
  const reverse=axisPlan({frame:10000,speed:-1,repeat:true,...bounds},48000,48000,"pv");
  assert.equal(reverse.frame,23999);
  assert.equal(axisPlan({frame:30000,speed:1,repeat:false,...bounds},48000,48000,"raw").frame,30000);
  const freeze=axisPlan({frame:18000,speed:0,repeat:true,...bounds},48000,48000,"raw");
  assert.equal(freeze.anchor,18000);assert.equal(freeze.b-freeze.a,2400);
  assert.throws(()=>axisPlan({frame:0,speed:1,rangeStartFrame:2,rangeEndFrame:2},48000,48000,"raw"),/反復区間/);
});

test("pingpong uses original coordinates, and freeze retains original PCM context",async()=>{
  const signal={sampleRate:48000,channels:[Float32Array.from({length:48000},(_,i)=>i/48000)]};
  const config={frame:12002,speed:-1,repeat:true,loopStyle:"pingpong",rangeStartFrame:12000,rangeEndFrame:12004,returning:true};
  const route=axisSource(signal,config,"pv");
  assert.equal(route.reader.sourceFrames,6);assert.equal(route.frame,4);
  assert.equal(route.reader.toSourceFrame(route.frame),12002);
  assert.equal(route.reader.isReturning(route.frame),true);
  assert.deepEqual((await route.reader.read(0,6)).channels[0],Float32Array.from([12000,12001,12002,12003,12002,12001],i=>i/48000));
  for(const mode of ["raw","pv"]){
    const frozen=axisSource(signal,{...config,speed:0},mode);
    assert.equal(frozen.reader,null);assert.equal(frozen.plan.anchor,12002);
  }
  const normal=axisSource(signal,{...config,repeat:false},"raw");
  assert.equal(normal.reader,null);assert.equal(normal.frame,12002);
});
