import {createSourcePCMBridge} from "../shared/atf/source-pcm-bridge.mjs";
import {createScrubPair} from "./scrub-pair.mjs";

// A single active output bridge. A/B replacement retains the common sample
// coordinate. Command acceptance is not render-thread acknowledgement.
export function createPreviewPlayer(ctx,{onState=()=>{}}={}){
  let current=null,position=0,running=false,revision=0,disposed=false;
  const gain=ctx.createGain();gain.gain.value=0;
  // Preview-only ceiling. Spectral resynthesis can exceed the cached peak.
  const ceiling=ctx.createWaveShaper();
  ceiling.curve=Float32Array.from({length:2049},(_,i)=>Math.max(-.9,Math.min(.9,i/1024-1)));
  gain.connect(ceiling);ceiling.connect(ctx.destination);
  const report=(extra={})=>onState({position,running,...extra});
  function ensure(){if(disposed)throw Error("再生機構は終了済みです");}
  async function load(signal,appliedGain,{frame=position,resume=running,scrub=null,positions={}}={}){
    ensure();const token=++revision;
    const length=signal.channels[0].length;
    const initial=Math.min(length,Math.max(0,Math.round(frame)));
    let next;
    try{
      const onEvent=event=>{
        if(current!==next||disposed)return;
        if(event.type==="progress"||event.type==="render-applied"||event.type==="axis-accepted"||event.type==="pair-accepted"){
          position=event.sourceFrame;running=event.running&&!event.ended;
          report({event,axes:event.axes});
        }else if(event.type==="fatal-error"){if(!event.axis)running=false;report({error:event.message,event});}
      };
      next=scrub?await createScrubPair({ctx,dry:signal,wet:scrub.wet,mode:scrub.mode,mix:scrub.mix,solo:scrub.solo,onEvent,
        positions:{source:{frame:initial,...positions.source},wet:{frame:initial,...positions.wet}}}):
        await createSourcePCMBridge({ctx,sourceChannels:signal.channels,sourceSampleRate:signal.sampleRate,startFrame:initial,processingMode:"raw",onEvent});
      if(disposed||token!==revision){next.dispose();return false;}
      const paused=current?await current.pause():null;
      if(disposed||token!==revision){next.dispose();return false;}
      // The command receipt is newer than a periodic progress snapshot.
      const target=resume?Math.min(length,Math.max(0,Math.round(paused?.sourceFrame??position))):initial;
      if(target!==initial){
        if(scrub){
          await next.configure("source",{frame:target});
          if(!positions.wet)await next.configure("wet",{frame:target});
        }else await next.seek(target);
      }
      if(disposed||token!==revision){next.dispose();return false;}
      current?.dispose();current=next;
      position=target;running=false;
      gain.gain.value=appliedGain;current.connect(gain);
      // A paired transport may have exhausted Source while Wet continues.
      if(resume&&(scrub||target<length)){await current.play();running=true;}
      report({phase:"ready"});return true;
    }catch(error){if(next&&next!==current)next.dispose();throw error;}
  }
  async function play(){ensure();if(!current)return;await current.play();running=true;report({phase:"accepted"});}
  async function pause(){ensure();if(!current)return;const receipt=await current.pause();position=receipt.sourceFrame;running=false;report({phase:"accepted"});}
  async function seek(frame){ensure();if(!current)return;const receipt=await current.seek(Math.round(frame));if(!receipt.stale){position=receipt.sourceFrame;report({phase:"accepted"});}}
  async function configureAxis(name,config){ensure();if(!current?.configure)throw Error("この方式は独立軸を使用しません");return current.configure(name,config);}
  function setMix(mix,solo){if(!current?.setMix)return false;current.setMix(mix,solo);return true;}
  function dispose(){if(disposed)return;disposed=true;++revision;current?.dispose();current=null;gain.disconnect();ceiling.disconnect();}
  return {load,play,pause,seek,configureAxis,setMix,dispose,get state(){return {position,running,axes:current?.axes};}};
}
