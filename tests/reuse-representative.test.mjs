import test from "node:test";
import assert from "node:assert/strict";
import {createSourceTimeline} from "../shared/atf/source-timeline.mjs";
import {createSourcePCMRenderer} from "../shared/atf/source-pcm-renderer.mjs";
import {createSpectralTimePitch} from "../shared/atf/source-spectral.mjs";
import {createProgressivePCMCache} from "../shared/atf/progressive-source-cache.mjs";
import {createWetMixBinding,mountWetMixField} from "../src/wet-mix.mjs";

test("Source, IR and Wet can have independent signed sample clocks",()=>{
  const config={sourceFrames:48000,sourceSampleRate:48000,startFrame:12000};
  const source=createSourceTimeline(config),ir=createSourceTimeline({...config,speed:0}),
    wet=createSourceTimeline({...config,speed:-1});
  for(const x of [source,ir,wet])x.advance(480);
  assert.deepEqual([source.state.sourceFrame,ir.state.sourceFrame,wet.state.sourceFrame],[12480,12000,11520]);
  ir.setSpeed(2);ir.advance(480);
  assert.equal(ir.state.sourceFrame,12960);
  assert.equal(wet.state.sourceFrame,11520);
});

test("phase-continuous IR reference freeze produces stereo finite non-DC PCM",()=>{
  const sampleRate=48000,sourceFrames=48000,startFrame=12000;
  const ir=Array.from({length:2},(_,ch)=>Float32Array.from({length:sourceFrames},(_,i)=>
    (ch?0.24:0.5)*Math.exp(-i/sourceFrames)*Math.sin(2*Math.PI*440*i/sampleRate+(ch?0.5:0))));
  const renderer=createSourcePCMRenderer({sourceFrames,sourceSampleRate:sampleRate,
    outputSampleRate:sampleRate,channelCount:2,startFrame,speed:0});
  renderer.installWindow(0,ir);
  const synth=createSpectralTimePitch({sourceSampleRate:sampleRate,outputSampleRate:sampleRate,
    channelCount:2,phaseLock:true});
  const output=[new Float32Array(8192),new Float32Array(8192)];
  for(let i=0;i<8192;i+=128){
    const block=[new Float32Array(128),new Float32Array(128)];
    assert.equal(renderer.renderSpectral(block,synth),0);
    for(let ch=0;ch<2;ch++)output[ch].set(block[ch],i);
  }
  assert.equal(renderer.timeline.state.sourceFrame,startFrame);
  for(const channel of output)assert.ok(channel.every(Number.isFinite));
  const body=output[0].subarray(2048);
  assert.ok(Math.max(...body)-Math.min(...body)>.1);
  const energy=f=>{let r=0,j=0;for(let i=0;i<body.length;i++){
    const a=2*Math.PI*f*i/sampleRate;r+=body[i]*Math.cos(a);j+=body[i]*Math.sin(a);}
    return Math.hypot(r,j);};
  assert.ok(energy(440)>energy(400)*1.2);
  assert.ok(output[1].some((v,i)=>i>2048&&Math.abs(v-output[0][i])>.015));
});

test("IR and Wet read caches have separate ownership and bounded residency",async()=>{
  const make=offset=>createProgressivePCMCache({sourceFrames:4096,channelCount:1,
    windowFrames:256,maxCachedWindows:2,decodeWindow:async(start,length)=>
      [Float32Array.from({length},(_,i)=>offset+start+i)]});
  const ir=make(10),wet=make(20);
  try{
    for(const start of [0,512,1024])await ir.read(start,16,{priority:"playback"});
    assert.equal((await ir.read(1024,1)).channels[0][0],1034);
    assert.equal((await wet.read(1024,1)).channels[0][0],1044);
    assert.ok(ir.stats().residentWindows<=2);assert.ok(wet.stats().residentWindows<=2);
  }finally{ir.dispose();wet.dispose();}
});

test("FW canonical wet binding and typed field retain exact valid value",()=>{
  class Field extends EventTarget{
    constructor(){super();this.value="";this.dataset={};}
    select(){} blur(){this.dispatchEvent(new Event("blur"));}
  }
  const field=new Field(),binding=createWetMixBinding(),updates=[];
  const mounted=mountWetMixField({field,binding,onChanged:value=>updates.push(value)});
  assert.equal(field.value,"50");
  field.value="33.125";field.dispatchEvent(new Event("input"));
  assert.ok(Math.abs(binding.value-.33125)<1e-12);
  field.dispatchEvent(new Event("change"));assert.equal(updates.length,1);
  field.value="";field.dispatchEvent(new Event("input"));
  assert.equal(field.dataset.invalid,"true");
  assert.ok(Math.abs(binding.value-.33125)<1e-12);
  mounted.dispose();
  field.value="80";field.dispatchEvent(new Event("input"));assert.equal(updates.length,1);
});
