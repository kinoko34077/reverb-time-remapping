import {createSourcePCMBridge} from "../shared/atf/source-pcm-bridge.mjs";
import {validatePlaybackSpeed} from "../shared/atf/source-timeline.mjs";

export const isScrubMode=mode=>mode==="wet-buffer"||mode==="wet-spectral";
export function scrubGains(wet,solo){
  if(!Number.isFinite(wet)||wet<0||wet>1||!["dry","wet","mix"].includes(solo))throw RangeError("無効な試聴比率");
  return solo==="dry"?[1,0]:solo==="wet"?[0,1]:[1-wet,wet];
}
// Buffer freeze is a local raw loop, not a zero-speed PCM sample. The anchor
// stays fixed while the carrier loops. PV freeze uses the upstream speed=0.
export function axisPlan({frame,speed,repeat=false},length,sampleRate,processingMode){
  validatePlaybackSpeed(speed);
  if(!Number.isSafeInteger(frame)||frame<0||frame>length||!Number.isSafeInteger(length)||length<1)
    throw RangeError("参照位置が範囲外です");
  const anchor=Math.min(frame,length-1);
  if(speed===0&&processingMode==="raw"){
    const width=Math.min(length,Math.max(1,Math.round(.05*sampleRate)));
    const a=Math.min(Math.max(0,anchor-Math.floor(width/2)),length-width);
    return {anchor,frame:anchor,speed:1,a,b:a+width,loop:true,frozen:true};
  }
  return {anchor,frame:speed<0||speed===0?anchor:frame,speed,a:0,b:length,loop:!!repeat,frozen:speed===0};
}
// Two real shared Worklets. Only the comparison-specific mix, freeze
// interpretation and ownership live here; no second time/pitch algorithm.
export async function createScrubPair({ctx,dry,wet,mode,mix,solo,onEvent=()=>{},positions={}}){
  const length=dry.channels[0].length,sr=dry.sampleRate;
  if(!isScrubMode(mode)||wet.channels[0].length!==length||wet.sampleRate!==sr||wet.origin!==dry.origin)
    throw RangeError("共通座標のWetキャッシュが必要です");
  let closed=false,running=false,connected=false;
  const tracks={},nodes=[],gains=scrubGains(mix,solo);
  const state=()=>Object.fromEntries(Object.entries(tracks).map(([k,t])=>[k,{frame:t.config.speed===0?t.anchor:t.frame,speed:t.config.speed,repeat:t.config.repeat,ended:t.ended}]));
  const report=(event)=>onEvent({...event,sourceFrame:state().source?.frame??0,running,ended:Object.values(tracks).every(t=>t.ended),axes:state()});
  const setup=async(name,signal,processingMode,value)=>{
    const config={frame:0,speed:1,repeat:false,...positions[name]};
    const plan=axisPlan(config,length,sr,processingMode);
    const gain=ctx.createGain();gain.gain.value=value;nodes.push(gain);
    const t={config,anchor:plan.anchor,frame:plan.frame,ended:false,gain,processingMode,bridge:null};
    tracks[name]=t;
    t.bridge=await createSourcePCMBridge({ctx,sourceChannels:signal.channels,sourceSampleRate:sr,
      processingMode,startFrame:plan.frame,speed:plan.speed,loopStartFrame:plan.a,loopEndFrame:plan.b,loopEnabled:plan.loop,
      onEvent:event=>{
        if(closed||!connected)return;
        if(event.type==="progress"||event.type==="render-applied"){
          t.frame=event.sourceFrame;if(event.type==="progress")t.ended=!!event.ended;
          report({...event,axis:name,axisSourceFrame:event.sourceFrame});
        }else if(event.type==="fatal-error"){
          t.gain.gain.value=0;report({...event,axis:name});
        }
      }});
    t.bridge.connect(gain);
  };
  function dispose(){if(closed)return;closed=true;for(const t of Object.values(tracks))t.bridge?.dispose();for(const node of nodes)node.disconnect();}
  try{await setup("source",dry,"raw",gains[0]);await setup("wet",wet,mode==="wet-spectral"?"pv":"raw",gains[1]);}
  catch(error){dispose();throw error;}
  async function configure(name,config){
    if(closed||!tracks[name])throw Error("参照軸がありません");
    const t=tracks[name],next={...t.config,frame:state()[name].frame,...config};
    next.frame=Math.min(length,Math.max(0,Math.round(next.frame)));
    const plan=axisPlan(next,length,sr,t.processingMode);
    // Use upstream atomic loop configuration and scrub. Pause is not needed
    // for parameter updates, and the other axis is never commanded here.
    const prior=t.config,priorPlan=axisPlan({...prior,frame:Math.round(state()[name].frame)},length,sr,t.processingMode);
    if(plan.loop!==priorPlan.loop||plan.a!==priorPlan.a||plan.b!==priorPlan.b)
      await t.bridge.setLoopConfiguration(plan.a,plan.b,plan.loop);
    const receipt=await t.bridge.scrub(Math.min(length-1,plan.frame),plan.speed);
    if(receipt.stale)return receipt;
    t.config=next;t.anchor=plan.anchor;t.frame=receipt.sourceFrame;t.ended=false;
    report({type:"axis-accepted",axis:name});
    return receipt;
  }
  return {
    connect(destination){for(const t of Object.values(tracks))t.gain.connect(destination);connected=true;},
    async play(){await Promise.all(Object.values(tracks).map(t=>t.bridge.play()));running=true;report({type:"pair-accepted"});},
    async pause(){const receipts=await Promise.all(Object.values(tracks).map(t=>t.bridge.pause()));
      Object.values(tracks).forEach((t,i)=>t.frame=receipts[i].sourceFrame);running=false;report({type:"pair-accepted"});return {sourceFrame:state().source.frame};},
    async seek(frame){await Promise.all(["source","wet"].map(name=>configure(name,{frame})));return {sourceFrame:state().source.frame};},
    configure,dispose,get axes(){return state();},
    setMix(mix,solo){const values=scrubGains(mix,solo);Object.values(tracks).forEach((t,i)=>t.gain.gain.setTargetAtTime(values[i],ctx.currentTime,.005));}
  };
}
