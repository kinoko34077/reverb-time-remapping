import {createSourcePCMBridge} from "../shared/atf/source-pcm-bridge.mjs";
import {createScrubPair} from "./scrub-pair.mjs";

// Routes are independently attenuated before a shared preview-only ceiling.
export function createPreviewPlayer(ctx,{onState=()=>{}}={}){
  let current=null,route=null,position=0,running=false,revision=0,disposed=false;
  const retiring=new Set();
  const gain=ctx.createGain();gain.gain.value=1;
  const ceiling=ctx.createWaveShaper();
  ceiling.curve=Float32Array.from({length:2049},(_,i)=>Math.max(-.9,Math.min(.9,i/1024-1)));
  const volume=ctx.createGain();volume.gain.value=1;
  gain.connect(volume);volume.connect(ceiling);ceiling.connect(ctx.destination);
  const report=(extra={})=>onState({position,running,...extra});
  function ensure(){if(disposed)throw Error("再生機構は終了済みです");}
  function release(bridge,node){bridge?.dispose();node?.disconnect();}
  async function load(signal,appliedGain,{frame=position,resume=running,reset=false,scrub=null,positions={},crossfade=false}={}){
    ensure();const token=++revision;
    const length=signal.channels[0].length,initial=Math.min(length,Math.max(0,Math.round(frame)));
    let next,nextRoute,readyEvent=null,wake=null,timer=null;
    const stale=()=>disposed||token!==revision;
    const abandon=()=>{release(next,nextRoute);return false;};
    try{
      const onEvent=event=>{
        if(disposed)return;
        if(event.type==="render-applied"&&event.running&&event.missingFramesInBlock===0){
          readyEvent=event;wake?.();
        }
        if(current!==next)return;
        if(event.type==="progress"||event.type==="render-applied"||event.type==="axis-accepted"||event.type==="pair-accepted"){
          position=event.sourceFrame;running=event.running&&!event.ended;
          report({event,axes:event.axes,calibration:event.calibration});
        }else if(event.type==="fatal-error"){if(!event.axis)running=false;report({error:event.message,event});}
      };
      next=scrub?await createScrubPair({ctx,dry:signal,wet:scrub.wet,mode:scrub.mode,mix:scrub.mix,solo:scrub.solo,calibration:scrub.calibration,onEvent,
        positions:{source:{frame:initial,...positions.source},wet:{frame:initial,...positions.wet}}}):
        await createSourcePCMBridge({ctx,sourceChannels:signal.channels,sourceSampleRate:signal.sampleRate,startFrame:initial,processingMode:"raw",onEvent});
      if(stale())return abandon();
      nextRoute=ctx.createGain();nextRoute.gain.value=0;
      next.connect(nextRoute);nextRoute.connect(gain);
      if(crossfade&&resume&&running&&!scrub&&current?.processingMode==="raw"){
        // Align to the last render-thread clock sample, not a UI slider.
        // Separate Worklets do not provide sample-exact scheduled starts.
        const last=current.latest;
        const estimated=last?.running&&!last.ended&&Number.isFinite(last.outputTime)?
          last.sourceFrame+Math.max(0,ctx.currentTime-last.outputTime)*signal.sampleRate:position;
        const target=Math.min(length,Math.max(0,Math.round(estimated)));
        if(target<length){
          await next.seek(target);
          if(stale())return abandon();
          readyEvent=null;
          await next.play();
          if(!readyEvent)await new Promise((resolve,reject)=>{
            wake=resolve;timer=setTimeout(()=>reject(Error("新しいIR出力の準備が確認できません")),2500);
          });
          if(stale())return abandon();
          const previous={bridge:current,node:route};
          retiring.add(previous);
          const now=ctx.currentTime,end=now+.025;
          route.gain.cancelScheduledValues(now);route.gain.setValueAtTime(route.gain.value,now);
          route.gain.linearRampToValueAtTime(0,end);
          nextRoute.gain.setValueAtTime(0,now);nextRoute.gain.linearRampToValueAtTime(appliedGain,end);
          current=next;route=nextRoute;position=readyEvent.sourceFrame;running=true;
          report({phase:"crossfade",event:readyEvent});
          await new Promise(resolve=>setTimeout(resolve,40));
          release(previous.bridge,previous.node);retiring.delete(previous);
          report({phase:"ready"});return true;
        }
      }
      const paused=current?await current.pause():null;
      if(stale())return abandon();
      const target=reset?initial:resume?Math.min(length,Math.max(0,Math.round(paused?.sourceFrame??position))):initial;
      if(target!==initial){
        if(scrub){
          await next.configure("source",{frame:target});
          if(!positions.wet)await next.configure("wet",{frame:target});
        }else await next.seek(target);
      }
      if(stale())return abandon();
      release(current,route);current=next;route=nextRoute;
      position=target;running=false;route.gain.value=appliedGain;
      if(resume&&(scrub||target<length)){
        const active=current;
        await active.play();
        if(stale()){
          try{await active.pause();}catch{}
          if(current===active)running=false;
          return false;
        }
        running=true;
      }
      report({phase:"ready"});return true;
    }catch(error){if(next!==current)release(next,nextRoute);throw error;}
    finally{if(timer!==null)clearTimeout(timer);wake=null;}
  }
  async function play(){
    ensure();if(!current)return false;
    const token=revision,target=current;
    await target.play();
    if(disposed||current!==target||token!==revision){try{await target.pause();}catch{}return false;}
    running=true;report({phase:"accepted"});return true;
  }
  async function pause(){
    ensure();if(!current)return;
    const token=revision,target=current,receipt=await target.pause();
    if(disposed||current!==target||token!==revision)return;
    position=receipt.sourceFrame;running=false;report({phase:"accepted"});
  }
  async function stop(){
    ensure();const token=++revision,target=current;
    if(!target){position=0;running=false;report({phase:"stopped"});return;}
    await target.pause();
    if(disposed||current!==target||token!==revision)return;
    const receipt=await target.seek(0);
    if(disposed||current!==target||token!==revision)return;
    position=receipt?.sourceFrame??0;running=false;report({phase:"stopped"});
  }
  async function seek(frame){
    ensure();if(!current)return;
    const token=revision,target=current,receipt=await target.seek(Math.round(frame));
    if(!receipt.stale&&!disposed&&current===target&&token===revision){position=receipt.sourceFrame;report({phase:"accepted"});}
  }
  async function configureAxis(name,config){ensure();if(!current?.configure)throw Error("この方式は独立軸を使用しません");return current.configure(name,config);}
  function setCalibration(mode){if(!current?.setCalibration)return false;return current.setCalibration(mode);}
  function setMix(mix,solo){if(!current?.setMix)return false;current.setMix(mix,solo);return true;}
  function setVolume(value){
    if(!Number.isFinite(value)||value<0||value>1)throw RangeError("出力音量は0–100%です");
    volume.gain.setTargetAtTime(value,ctx.currentTime,.005);
  }
  function dispose(){
    if(disposed)return;disposed=true;++revision;release(current,route);current=null;route=null;
    for(const prior of retiring)release(prior.bridge,prior.node);retiring.clear();
    gain.disconnect();volume.disconnect();ceiling.disconnect();
  }
  return {load,play,pause,stop,seek,configureAxis,setMix,setCalibration,setVolume,dispose,get state(){return {position,running,axes:current?.axes,calibration:current?.calibration};}};
}
