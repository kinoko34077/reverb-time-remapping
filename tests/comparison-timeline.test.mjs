import test from "node:test";
import assert from "node:assert/strict";
import {createComparisonTimeline} from "../src/comparison-timeline.mjs";

test("comparison timeline maps signed frames to a stable shared time axis",()=>{
  const timeline=createComparisonTimeline({interval:{start:-3,end:9},sampleRate:3});
  assert.equal(timeline.length,12);
  assert.equal(timeline.timeAtFrame(0),-1);
  assert.equal(timeline.timeAtFrame(3),0);
  assert.equal(timeline.frameAtTime(0),3);
  assert.equal(timeline.frameAtTime(2),9);
  assert.equal(timeline.clampFrame(-4),0);
  assert.equal(timeline.clampFrame(99),12);
});

test("comparison timeline rejects invalid coordinates and non-finite conversions",()=>{
  assert.throws(()=>createComparisonTimeline({interval:{start:1,end:1},sampleRate:48_000}),RangeError);
  assert.throws(()=>createComparisonTimeline({interval:{start:0,end:1.5},sampleRate:48_000}),RangeError);
  const timeline=createComparisonTimeline({interval:{start:0,end:1},sampleRate:48_000});
  assert.throws(()=>timeline.frameAtTime(NaN),RangeError);
  assert.throws(()=>timeline.timeAtFrame(Infinity),RangeError);
});
