import test from "node:test";
import assert from "node:assert/strict";
import {readWetOverviewPeak} from "../app/wet-wave-view.mjs";

test("Wet overview aggregates a long range over bounded contiguous PCM reads",async()=>{
  const left=Float32Array.from({length:100},(_,index)=>Math.sin(index*.31));
  const right=Float32Array.from({length:100},(_,index)=>Math.cos(index*.17)*.6);
  const reads=[];
  const reader={sourceFrames:100,windowFrames:8,maxReadFrames:11,
    async read(startFrame,frameCount){
      reads.push({startFrame,frameCount});
      assert.ok(frameCount<=8);
      return {startFrame,channels:[left.slice(startFrame,startFrame+frameCount),
        right.slice(startFrame,startFrame+frameCount)]};
    }};
  const start=5,end=35,peak=await readWetOverviewPeak(reader,start,end);
  const samples=[...left.slice(start,end),...right.slice(start,end)];
  assert.deepEqual(peak,[Math.min(...samples),Math.max(...samples)]);
  assert.deepEqual(reads,[{startFrame:5,frameCount:8},{startFrame:13,frameCount:8},
    {startFrame:21,frameCount:8},{startFrame:29,frameCount:6}]);
});

test("Wet overview stops between bounded reads after its view becomes stale",async()=>{
  let reads=0,checks=0;
  const reader={sourceFrames:100,windowFrames:8,maxReadFrames:11,
    async read(startFrame,frameCount){
      reads++;
      return {startFrame,channels:[new Float32Array(frameCount)]};
    }};
  const peak=await readWetOverviewPeak(reader,0,30,{isCurrent:()=>++checks<3});
  assert.equal(peak,null);
  assert.equal(reads,1);
});
