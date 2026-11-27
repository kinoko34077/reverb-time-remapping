import {createSourcePCMBridge} from "../shared/atf/source-pcm-bridge.mjs";

// A single active output bridge. A/B replacement retains the common sample
// coordinate. Command acceptance is not render-thread acknowledgement.
export function createPreviewPlayer(ctx,{onState=()=>{}}={}){
  let current=null,position=0,running=false,revision=0,disposed=false;
  const gain=ctx.createGain();gain.gain.value=0;gain.connect(ctx.destination);
  const report=(extra={})=>onState({position,running,...extra});
  function ensure(){if(disposed)throw Error("再生機構は終了済みです");}
  async function load(signal,appliedGain,{frame=position,resume=running}={}){
    ensure();const token=++revision;
    const length=signal.channels[0].length;
    const initial=Math.min(length,Math.max(0,Math.round(frame)));
    let next;
    try{
      next=await createSourcePCMBridge({ctx,sourceChannels:signal.channels,sourceSampleRate:signal.sampleRate,startFrame:initial,
        processingMode:"raw",onEvent:event=>{
          if(current!==next||disposed)return;
          if(event.type==="progress"||event.type==="render-applied"){
            position=event.sourceFrame;running=event.running&&!event.ended;
            report({event});
          }else if(event.type==="fatal-error"){running=false;report({error:event.message,event});}
        }});
      if(disposed||token!==revision){next.dispose();return false;}
      const paused=current?await current.pause():null;
      if(disposed||token!==revision){next.dispose();return false;}
      // The command receipt is newer than a periodic progress snapshot.
      const target=resume?Math.min(length,Math.max(0,Math.round(paused?.sourceFrame??position))):initial;
      if(target!==initial)await next.seek(target);
      if(disposed||token!==revision){next.dispose();return false;}
      current?.dispose();current=next;
      position=target;running=false;
      gain.gain.value=appliedGain;current.connect(gain);
      if(resume&&target<length){await current.play();running=true;}
      report({phase:"ready"});return true;
    }catch(error){if(next&&next!==current)next.dispose();throw error;}
  }
  async function play(){ensure();if(!current)return;await current.play();running=true;report({phase:"accepted"});}
  async function pause(){ensure();if(!current)return;const receipt=await current.pause();position=receipt.sourceFrame;running=false;report({phase:"accepted"});}
  async function seek(frame){ensure();if(!current)return;const receipt=await current.seek(Math.round(frame));if(!receipt.stale){position=receipt.sourceFrame;report({phase:"accepted"});}}
  function dispose(){if(disposed)return;disposed=true;++revision;current?.dispose();current=null;gain.disconnect();}
  return {load,play,pause,seek,dispose,get state(){return {position,running};}};
}
