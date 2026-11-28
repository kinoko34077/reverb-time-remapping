import test from "node:test";
import assert from "node:assert/strict";
import {createComparisonTimeline,createModeOutputContract} from "../src/comparison-timeline.mjs";

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

test("mode output contract preserves Reverse lookahead and signed comparison origin",()=>{
  const timeline=createComparisonTimeline({interval:{start:-2,end:6},sampleRate:1});
  const reverse=createModeOutputContract({mode:"reverse",timeline,sourceFrames:6,irFrames:3,delayFrames:0});
  assert.deepEqual(reverse.requiredSourceRange(0,2),{start:0,end:2,lookaheadFrames:2,tailFrames:0});
  assert.deepEqual(reverse.requiredSourceRange(2,2),{start:0,end:4,lookaheadFrames:2,tailFrames:0});
  assert.deepEqual(reverse.requiredSourceRange(6,2),{start:4,end:6,lookaheadFrames:2,tailFrames:0});
});

test("mode output contract reports forward convolution history and output tail",()=>{
  const timeline=createComparisonTimeline({interval:{start:0,end:6},sampleRate:1});
  const normal=createModeOutputContract({mode:"normal",timeline,sourceFrames:6,irFrames:3,delayFrames:1});
  assert.deepEqual(normal.requiredSourceRange(0,2),{start:0,end:1,lookaheadFrames:0,tailFrames:2});
  assert.deepEqual(normal.requiredSourceRange(4,2),{start:1,end:5,lookaheadFrames:0,tailFrames:2});
});

test("mode output contract converts processing ranges to the source frame clock",()=>{
  const timeline=createComparisonTimeline({interval:{start:0,end:8},sampleRate:1});
  const dry=createModeOutputContract({mode:"dry",timeline,sourceFrames:5,sourceSampleRate:2,irFrames:1});
  assert.deepEqual(dry.requiredSourceRange(1,2),{start:2,end:5,lookaheadFrames:0,tailFrames:0});
});
