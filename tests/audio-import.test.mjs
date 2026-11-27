import test from "node:test";
import assert from "node:assert/strict";
import {readLocalAudio} from "../src/materials.mjs";

test("native decoder preserves channel data and rejects invalid/oversize material",async()=>{
  const file=new Blob([new Uint8Array([255,251,16,0])],{type:"audio/mpeg"});
  const left=Float32Array.of(.1,.2),right=Float32Array.of(-.3,.4);
  class Context{
    constructor(ch,n,sr){assert.equal(sr,48000);}
    async decodeAudioData(){return {sampleRate:48000,numberOfChannels:2,length:2,getChannelData:i=>[left,right][i]};}
  }
  const out=await readLocalAudio(file,{Context});
  assert.deepEqual(out.channels,[left,right]);
  assert.notEqual(out.channels[0],left);
  await assert.rejects(readLocalAudio(file,{Context,maxBytes:8}),/budget/);
  class Bad extends Context{async decodeAudioData(){throw Error("bad");}}
  await assert.rejects(readLocalAudio(file,{Context:Bad}),/デコード/);
  class Multi extends Context{async decodeAudioData(){return {numberOfChannels:3,length:2};}}
  await assert.rejects(readLocalAudio(file,{Context:Multi}),/ステレオ/);
});
