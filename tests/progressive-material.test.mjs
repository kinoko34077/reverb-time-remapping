import test from "node:test";
import assert from "node:assert/strict";
import {openProgressiveMaterial,estimatePreparedComparisonBytes,materializeProgressiveSource} from "../src/progressive-material.mjs";

function mediaFor(channels){
  const inputs=[];
  class Input{
    constructor(){this.disposed=false;inputs.push(this);}
    async canRead(){return true;}
    async getPrimaryAudioTrack(){return {canDecode:async()=>true,getNumberOfChannels:async()=>channels,getSampleRate:async()=>48000};}
    async getFirstTimestamp(){return 0;}
    async getDurationFromMetadata(){return 180;}
    dispose(){this.disposed=true;}
  }
  class BlobSource{constructor(file){this.file=file;}}
  class AudioSampleSink{samples(){throw Error("not read in metadata test");}}
  return {api:{Input,BlobSource,AudioSampleSink,ALL_FORMATS:[]},inputs};
}

test("progressive material preserves full duration, rate and stereo channels",async()=>{
  const {api,inputs}=mediaFor(2);
  const source=await openProgressiveMaterial({name:"three-minutes.mp3"},{media:api});
  assert.equal(source.duration,180);assert.equal(source.sampleRate,48000);
  assert.equal(source.channelCount,2);assert.equal(source.sourceFrames,8640000);
  assert.equal(inputs[0].disposed,true,"metadata probe releases its input");
  source.dispose();assert.ok(inputs.every(input=>input.disposed));
});

test("progressive material rejects multichannel audio rather than silently dropping channels",async()=>{
  const {api,inputs}=mediaFor(6);
  await assert.rejects(openProgressiveMaterial({name:"surround.mp3"},{media:api}),/モノラル|ステレオ/);
  assert.ok(inputs.every(input=>input.disposed));
});

test("metadata probe keeps short native-decodable audio available without WebCodecs",async()=>{
  let disposed=false;
  const api={ALL_FORMATS:[],BlobSource:class{},AudioSampleSink:class{},Input:class{
    async canRead(){return true;}
    async getPrimaryAudioTrack(){return {getNumberOfChannels:async()=>2,getSampleRate:async()=>44100,canDecode:async()=>false};}
    async getFirstTimestamp(){return 0;}
    async getDurationFromMetadata(){return 3;}
    dispose(){disposed=true;}
  }};
  const source=await openProgressiveMaterial({name:"native-only.mp3"},{media:api});
  assert.equal(source.canReadPCM,false);assert.equal(source.duration,3);
  assert.equal(source.sourceFrames,132_300);assert.equal(source.channelCount,2);
  assert.equal(disposed,true);
  await assert.rejects(source.read(0,128),/逐次音声デコードに対応/);
  source.dispose();
});

test("prepared comparison estimate routes a three-minute stereo source away from full PCM caches",()=>{
  const short=estimatePreparedComparisonBytes({sourceFrames:48000,sourceSampleRate:48000,
    sourceChannels:2,irFrames:72000,irChannels:2});
  const long=estimatePreparedComparisonBytes({sourceFrames:7_939_588,sourceSampleRate:44100,
    sourceChannels:2,irFrames:72000,irChannels:2});
  assert.equal(short.length,191_998);assert.equal(short.bytes,15_359_840);assert.equal(short.withinBudget,true);
  assert.equal(long.withinBudget,false);assert.ok(long.bytes>600_000_000);
});

test("finite progressive source is read in bounded windows and materialized without changing its PCM",async()=>{
  const source={sourceFrames:10,channelCount:2,sampleRate:48000,windowFrames:4,
    async read(start,count){return {startFrame:start,channels:[
      Float32Array.from({length:count},(_,i)=>start+i),
      Float32Array.from({length:count},(_,i)=>-(start+i))
    ]};}};
  const material=await materializeProgressiveSource(source);
  assert.equal(material.sampleRate,48000);assert.equal(material.originalSampleRate,48000);
  assert.deepEqual(Array.from(material.channels[0]),[0,1,2,3,4,5,6,7,8,9]);
  assert.deepEqual(Array.from(material.channels[1]),[-0,-1,-2,-3,-4,-5,-6,-7,-8,-9]);
});
