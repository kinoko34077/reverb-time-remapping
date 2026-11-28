import {createSourcePCMBridge} from "../shared/atf/source-pcm-bridge.mjs";
import {createScrubPair} from "./scrub-pair.mjs";
import {createLiveConvolutionGraph} from "./live-convolution.mjs";
import {matchKernelSampleRate,renderConvolutionHistory} from "./progressive-convolution.mjs";

// Routes are independently attenuated before a shared preview-only ceiling.
export function createPreviewPlayer(ctx,{onState=()=>{},createBridge=createSourcePCMBridge,
  restoreHistory=renderConvolutionHistory}={}){
  let current=null,route=null,currentGraph=null,currentSignal=null,currentGain=1,currentHistory=null;
  let position=0,running=false,revision=0,disposed=false,lastReadyEvent=null;
  const retiring=new Set();
  const readyWaiters=new Set();
  const gain=ctx.createGain();gain.gain.value=1;
  const ceiling=ctx.createWaveShaper();
  ceiling.curve=Float32Array.from({length:2049},(_,i)=>Math.max(-.9,Math.min(.9,i/1024-1)));
  const volume=ctx.createGain();volume.gain.value=1;
  gain.connect(volume);volume.connect(ceiling);ceiling.connect(ctx.destination);
  const report=(extra={})=>onState({position,running,...extra});
  function ensure(){if(disposed)throw Error("再生機構は終了済みです");}
  function stopHistory(history){
    if(!history?.buffer)return;
    if(history.started)history.offset=Math.min(history.buffer.duration,
      history.offset+Math.max(0,ctx.currentTime-history.startedAt));
    history.started=false;
    try{history.node?.stop();}catch{}
    history.node?.disconnect();history.gainNode?.disconnect();history.node=null;history.gainNode=null;
  }
  function startHistory(history,destination,outputTime=ctx.currentTime){
    if(!history?.buffer||history.node||history.offset>=history.buffer.duration)return;
    const elapsed=history.started?Math.max(0,ctx.currentTime-history.startedAt):
      Math.max(0,ctx.currentTime-outputTime);
    history.offset=Math.min(history.buffer.duration,history.offset+elapsed);
    history.started=true;history.startedAt=ctx.currentTime;
    if(history.offset>=history.buffer.duration||history.wetGain<=0)return;
    const node=ctx.createBufferSource(),gainNode=ctx.createGain();
    node.buffer=history.buffer;gainNode.gain.value=history.wetGain;
    node.connect(gainNode);gainNode.connect(destination);
    history.node=node;history.gainNode=gainNode;
    node.onended=()=>{if(history.node===node){history.offset=history.buffer.duration;history.started=false;history.node=null;history.gainNode=null;}};
    node.start(ctx.currentTime,history.offset);
  }
  function release(bridge,node,graph,history){
    stopHistory(history);bridge?.dispose();graph?.dispose();node?.disconnect();
  }
  function waitForRender(){
    if(lastReadyEvent)return Promise.resolve(lastReadyEvent);
    return new Promise((resolve,reject)=>{
      const waiter={resolve:event=>{clearTimeout(waiter.timer);readyWaiters.delete(waiter);resolve(event);}};
      readyWaiters.add(waiter);
      waiter.timer=setTimeout(()=>{readyWaiters.delete(waiter);reject(Error("音声出力の準備が確認できません"));},2500);
    });
  }
  const wetAmount=(mix,solo)=>solo==="dry"?0:solo==="wet"?1:mix;
  async function load(signal,appliedGain,{frame=position,resume=running,reset=false,scrub=null,positions={},crossfade=false}={}){
    ensure();const token=++revision;
    const reader=signal?.source&&typeof signal.source.read==="function"?signal.source:null;
    const length=reader?signal.sourceFrames:signal.channels[0].length;
    const initial=Math.min(length,Math.max(0,Math.round(frame)));
    let next,nextRoute,nextGraph=null,nextKernel=null,nextHistory=null,readyEvent=null;
    const stale=()=>disposed||token!==revision;
    const abandon=()=>{release(next,nextRoute,nextGraph,nextHistory);return false;};
    try{
      const onEvent=event=>{
        if(disposed)return;
        if(event.type==="render-applied"&&event.running&&event.missingFramesInBlock===0){
          readyEvent=event;lastReadyEvent=event;
          for(const waiter of [...readyWaiters])waiter.resolve(event);
        }
        if(current!==next)return;
        if(event.type==="progress"||event.type==="render-applied"||event.type==="axis-accepted"||event.type==="pair-accepted"){
          position=event.sourceFrame;running=event.running&&!event.ended;
          report({event,axes:event.axes,calibration:event.calibration});
        }else if(event.type==="fatal-error"){if(!event.axis)running=false;report({error:event.message,event});}
      };
      next=scrub?await createScrubPair({ctx,dry:signal,wet:scrub.wet,mode:scrub.mode,mix:scrub.mix,solo:scrub.solo,calibration:scrub.calibration,onEvent,
        positions:{source:{frame:initial,...positions.source},wet:{frame:initial,...positions.wet}}}):
        await createBridge({ctx,source:reader,sourceChannels:signal.channels,sourceSampleRate:signal.sampleRate,
          sourceFrames:reader?signal.sourceFrames:undefined,startFrame:initial,processingMode:"raw",onEvent});
      if(stale())return abandon();
      nextRoute=ctx.createGain();nextRoute.gain.value=0;
      if(reader&&["normal","ir-window"].includes(signal.mode)){
        const ir=await matchKernelSampleRate(ctx,signal.ir);
        if(stale())return abandon();
        if(signal.predelay<0)throw Error("長尺Normalの負Predelayには先読み経路が必要です");
        nextGraph=createLiveConvolutionGraph(ctx,{sourceChannels:reader.channelCount,ir,
          wet:signal.mix,solo:signal.solo,predelaySeconds:signal.predelay});
        nextKernel=ir;
        next.connect(nextGraph.input);nextGraph.output.connect(nextRoute);
      }else next.connect(nextRoute);
      const prepareHistory=async frame=>{
        if(!reader||!nextGraph)return null;
        const history=await restoreHistory(ctx,reader,nextKernel,frame,
          {predelaySeconds:signal.predelay});
        if(!history)return null;
        const buffer=ctx.createBuffer(history.channels.length,history.channels[0].length,history.sampleRate);
        history.channels.forEach((channel,index)=>buffer.copyToChannel(channel,index));
        return {buffer,offset:0,startedAt:0,started:false,
          wetGain:wetAmount(signal.mix,signal.solo),node:null,gainNode:null};
      };
      nextRoute.connect(gain);
      if(crossfade&&resume&&running&&!scrub&&current?.processingMode==="raw"){
        // Align to the last render-thread clock sample, not a UI slider.
        // Separate Worklets do not provide sample-exact scheduled starts.
        const last=current.latest;
        const estimated=last?.running&&!last.ended&&Number.isFinite(last.outputTime)?
          last.sourceFrame+Math.max(0,ctx.currentTime-last.outputTime)*signal.sampleRate:position;
        let target=Math.min(length,Math.max(0,Math.round(estimated)));
        if(target<length){
          await next.seek(target);
          if(stale())return abandon();
          // Freeze the old source clock before the potentially slow history read.
          // The accepted pause frame is the replacement's true handoff position.
          const paused=await current.pause();
          if(stale())return abandon();
          target=Math.min(length,Math.max(0,Math.round(paused?.sourceFrame??position)));
          if(target!==estimated)await next.seek(target);
          nextHistory=await prepareHistory(target);
          if(stale())return abandon();
          readyEvent=null;lastReadyEvent=null;
          await next.play();
           if(!readyEvent)readyEvent=await waitForRender();
          if(stale())return abandon();
          startHistory(nextHistory,nextRoute,readyEvent.outputTime);
          const previous={bridge:current,node:route,graph:currentGraph,history:currentHistory};
          retiring.add(previous);
          const now=ctx.currentTime,end=now+.025;
          route.gain.cancelScheduledValues(now);route.gain.setValueAtTime(route.gain.value,now);
          route.gain.linearRampToValueAtTime(0,end);
          nextRoute.gain.setValueAtTime(0,now);nextRoute.gain.linearRampToValueAtTime(appliedGain,end);
          current=next;route=nextRoute;currentGraph=nextGraph;currentHistory=nextHistory;
          currentSignal=signal;currentGain=appliedGain;position=readyEvent.sourceFrame;running=true;
          report({phase:"crossfade",event:readyEvent});
          await new Promise(resolve=>setTimeout(resolve,40));
          release(previous.bridge,previous.node,previous.graph,previous.history);retiring.delete(previous);
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
      nextHistory=await prepareHistory(target);
      if(stale())return abandon();
      release(current,route,currentGraph,currentHistory);current=next;route=nextRoute;
      currentGraph=nextGraph;currentHistory=nextHistory;currentSignal=signal;currentGain=appliedGain;
      position=target;running=false;route.gain.value=appliedGain;
      if(resume&&(scrub||target<length)){
        const active=current;
        await active.play();
        if(stale()){
          try{await active.pause();}catch{}
          if(current===active)running=false;
          // Stop may invalidate playback after this bridge was installed.
          // Keep the caller's mode state aligned with the bridge that remains current.
          return !disposed&&current===active;
        }
        running=true;
        if(currentHistory)startHistory(currentHistory,route,ctx.currentTime);
      }
      report({phase:"ready"});return true;
    }catch(error){if(next!==current)release(next,nextRoute,nextGraph,nextHistory);throw error;}
  }
  async function play(){
    ensure();if(!current)return false;
    if(!running&&currentSignal?.source&&["normal","ir-window"].includes(currentSignal.mode))
      return load(currentSignal,currentGain,{frame:position,resume:true,reset:true});
    const token=revision,target=current;
    lastReadyEvent=null;
    await target.play();
    if(disposed||current!==target||token!==revision){try{await target.pause();}catch{}return false;}
    running=true;
    if(currentHistory)startHistory(currentHistory,route,ctx.currentTime);
    report({phase:"accepted"});return true;
  }
  async function pause(){
    ensure();if(!current)return;
    const token=revision,target=current;
    const rebuildOnResume=currentSignal?.source&&["normal","ir-window"].includes(currentSignal.mode);
    stopHistory(currentHistory);
    if(rebuildOnResume)route?.gain.setTargetAtTime(0,ctx.currentTime,.003);
    const receipt=await target.pause();
    if(disposed||current!==target||token!==revision)return;
    position=receipt.sourceFrame;running=false;report({phase:"accepted"});
  }
  async function stop(){
    ensure();const token=++revision,target=current;
    if(!target){position=0;running=false;report({phase:"stopped"});return;}
    if(currentSignal?.source&&["normal","ir-window"].includes(currentSignal.mode)){
      await load(currentSignal,currentGain,{frame:0,resume:false,reset:true});
      if(disposed)return;
      position=0;running=false;report({phase:"stopped"});return;
    }
    await target.pause();
    if(disposed||current!==target||token!==revision)return;
    const receipt=await target.seek(0);
    if(disposed||current!==target||token!==revision)return;
    position=receipt?.sourceFrame??0;running=false;report({phase:"stopped"});
  }
  async function seek(frame){
    ensure();if(!current)return;
    if(currentSignal?.source&&["normal","ir-window"].includes(currentSignal.mode)){
      const resume=running;
      await load(currentSignal,currentGain,{frame:Math.round(frame),resume,reset:true});
      return;
    }
    const token=revision,target=current,receipt=await target.seek(Math.round(frame));
    if(!receipt.stale&&!disposed&&current===target&&token===revision){position=receipt.sourceFrame;report({phase:"accepted"});}
  }
  async function configureAxis(name,config){ensure();if(!current?.configure)throw Error("この方式は独立軸を使用しません");return current.configure(name,config);}
  function setCalibration(mode){if(!current?.setCalibration)return false;return current.setCalibration(mode);}
  function setMix(mix,solo){
    if(currentGraph){currentGraph.setMix(mix,solo);if(currentHistory)currentHistory.wetGain=wetAmount(mix,solo);
      if(currentHistory?.gainNode&&currentHistory.wetGain>0)
        currentHistory.gainNode.gain.setTargetAtTime(currentHistory.wetGain,ctx.currentTime,.005);
      else if(currentHistory?.gainNode)stopHistory(currentHistory);
      else if(currentHistory?.wetGain>0&&currentHistory.started)startHistory(currentHistory,route,currentHistory.startedAt);
      return true;}
    if(!current?.setMix)return false;current.setMix(mix,solo);return true;
  }
  function setVolume(value){
    if(!Number.isFinite(value)||value<0||value>1)throw RangeError("出力音量は0–100%です");
    volume.gain.setTargetAtTime(value,ctx.currentTime,.005);
  }
  function dispose(){
    if(disposed)return;disposed=true;++revision;release(current,route,currentGraph,currentHistory);
    current=null;route=null;currentGraph=null;currentHistory=null;
    for(const prior of retiring)release(prior.bridge,prior.node,prior.graph,prior.history);retiring.clear();
    gain.disconnect();volume.disconnect();ceiling.disconnect();
  }
  return {load,play,pause,stop,seek,configureAxis,setMix,setCalibration,setVolume,dispose,get state(){return {position,running,axes:current?.axes,calibration:current?.calibration};}};
}
