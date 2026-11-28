import {createSourcePCMBridge} from "../shared/atf/source-pcm-bridge.mjs";
import {validatePlaybackSpeed} from "../shared/atf/source-timeline.mjs";
import {createReflectedPCMSource} from "../shared/atf/reflected-pcm-source.mjs";
import {createLocalRMSCalibration,validateCalibration} from "./level-calibration.mjs";
import {createProgressiveWetPCMReader} from "./progressive-wet-reader.mjs";

export const isScrubMode=mode=>mode==="wet-buffer"||mode==="wet-spectral";
export function scrubGains(wet,solo){
  if(!Number.isFinite(wet)||wet<0||wet>1||!["dry","wet","mix"].includes(solo))throw RangeError("無効な試聴比率");
  return solo==="dry"?[1,0]:solo==="wet"?[0,1]:[1-wet,wet];
}
// Buffer freeze is a local raw loop, not a zero-speed PCM sample.
export function axisPlan({frame,speed,repeat=false,rangeStartFrame=0,rangeEndFrame},length,sampleRate,processingMode){
  rangeEndFrame??=length;
  validatePlaybackSpeed(speed);
  if(!Number.isSafeInteger(frame)||frame<0||frame>length||!Number.isSafeInteger(length)||length<1)
    throw RangeError("参照位置が範囲外です");
  if(!Number.isSafeInteger(rangeStartFrame)||!Number.isSafeInteger(rangeEndFrame)||
    rangeStartFrame<0||rangeStartFrame>=rangeEndFrame||rangeEndFrame>length)
    throw RangeError("反復区間は開始 < 終了、かつ比較範囲内にしてください");
  const cursor=repeat&&(frame<rangeStartFrame||frame>=rangeEndFrame)?
    (speed<0?rangeEndFrame-1:rangeStartFrame):frame;
  const anchor=Math.min(cursor,length-1);
  if(speed===0&&processingMode==="raw"){
    const width=Math.min(length,Math.max(1,Math.round(.05*sampleRate)));
    const a=Math.min(Math.max(0,anchor-Math.floor(width/2)),length-width);
    return {anchor,frame:anchor,speed:1,a,b:a+width,loop:true,frozen:true};
  }
  return {anchor,frame:speed<0||speed===0?anchor:cursor,speed,a:rangeStartFrame,b:rangeEndFrame,loop:!!repeat,frozen:speed===0};
}
// The reflected PCM reader is the canonical coordinate mapping, not a new clock.
export function axisSource(signal,config,processingMode){
  const reader=signal.reader??signal.source;
  const length=signal.sourceFrames??signal.channels?.[0]?.length;
  const plan=axisPlan(config,length,signal.sampleRate,processingMode);
  if(!["repeat","pingpong"].includes(config.loopStyle??"repeat"))throw RangeError("反復方式が不正です");
  if(reader&&config.repeat&&config.loopStyle==="pingpong")throw Error("長尺readerの往復ループは未対応です");
  // Freeze uses original context (not a reflected, possibly one-sample buffer).
  if(!config.repeat||config.loopStyle!=="pingpong"||plan.frozen)
    return {plan,reader:reader??null,frame:plan.frame,a:plan.a,b:plan.b,loop:plan.loop};
  const reflected=createReflectedPCMSource({channels:signal.channels,startFrame:plan.a,endFrame:plan.b});
  return {plan,reader:reflected,frame:reflected.toVirtualFrame(plan.frame,{returning:!!config.returning}),
    a:0,b:reflected.sourceFrames,loop:true};
}
export async function createScrubPair({ctx,dry,wet,mode,mix,solo,calibration="natural",onEvent=()=>{},positions={}}){
  const length=dry.sourceFrames??dry.channels?.[0]?.length,sr=dry.sampleRate;
  let wetLength=wet.sourceFrames??wet.channels?.[0]?.length;
  if(!isScrubMode(mode)||wetLength<length||wet.sampleRate!==sr||wet.origin!==dry.origin)
    throw RangeError("共通座標のWetキャッシュが必要です");
  const progressiveWet=wet.source&&typeof wet.source.read==="function"&&wet.mode==="normal"?
    await createProgressiveWetPCMReader(wet.source,wet.ir,{predelaySeconds:wet.predelay,Context:globalThis.OfflineAudioContext}):null;
  if(progressiveWet){
    if(wet.wetOutputFrames&&wet.wetOutputFrames!==progressiveWet.sourceFrames){
      progressiveWet.dispose();throw RangeError("Wet tailの出力長が比較座標と一致しません");
    }
    wetLength=progressiveWet.sourceFrames;wet={...wet,reader:progressiveWet,sourceFrames:wetLength};calibration="natural";
  }
  let closed=false,running=false,connected=false;
  let wetCalibration=validateCalibration(calibration),calibrationFrame=null,calibrationScale=1;
  const localLevel=progressiveWet?null:createLocalRMSCalibration(wet.channels,Math.max(1,Math.round(.05*sr)));
  const tracks={},routes=new Set(),stagedRoutes=new Set(),nodes=[],gains=scrubGains(mix,solo);
  const state=()=>Object.fromEntries(Object.entries(tracks).map(([k,t])=>[k,{
    frame:t.config.speed===0?t.anchor:t.frame,speed:t.config.speed,repeat:t.config.repeat,
    rangeStartFrame:t.config.rangeStartFrame,rangeEndFrame:t.config.rangeEndFrame,
    loopStyle:t.config.loopStyle,returning:t.returning,ended:t.ended}]));
  function applyCalibration(force=false){
    const t=tracks.wet;if(!t)return;
    const frame=Math.round(t.config.speed===0?t.anchor:t.frame);
    if(!force&&frame===calibrationFrame)return;
    calibrationFrame=frame;
    const scale=localLevel?.scaleAt(frame,wetCalibration)??1;
    if(force||scale!==calibrationScale){
      calibrationScale=scale;
      if(running)t.level.gain.setTargetAtTime(scale,ctx.currentTime,.01);
      else {t.level.gain.cancelScheduledValues(ctx.currentTime);t.level.gain.value=scale;}
    }
  }
  const calibrationState=()=>({mode:progressiveWet?"natural":wetCalibration,targetScale:calibrationScale,
    windowFrames:localLevel?.windowFrames??0,available:!progressiveWet});
  const report=event=>{
    applyCalibration();
    onEvent({...event,sourceFrame:state().source?.frame??0,running,
      ended:Object.values(tracks).every(t=>t.ended),axes:state(),calibration:calibrationState()});
  };
  const mapFrame=(route,frame)=>route.reader?.toSourceFrame?route.reader.toSourceFrame(frame):frame;
  const signalLength=signal=>signal.sourceFrames??signal.channels?.[0]?.length??length;
  function updateFrame(t,route,frame){
    t.frame=mapFrame(route,frame);
    if(route.reader?.isReturning)t.returning=route.reader.isReturning(frame);
  }
  function release(route){
    if(!route)return;
    routes.delete(route);route.bridge?.dispose();route.node.disconnect();
    route.reject?.(Error("参照経路を終了しました"));
  }
  function ensure(){if(closed)throw Error("再生機構を終了しました");}
  async function prepareRoute(t,config,source){
    const route={reader:source.reader,node:ctx.createGain(),bridge:null,receipt:null,resolve:null,reject:null,paused:false};
    route.node.gain.value=0;routes.add(route);
    try{
      route.bridge=await createSourcePCMBridge({ctx,...(source.reader?{source:source.reader}:{sourceChannels:t.signal.channels}),
        sourceSampleRate:sr,processingMode:t.processingMode,startFrame:source.frame,speed:source.plan.speed,
        loopStartFrame:source.a,loopEndFrame:source.b,loopEnabled:source.loop,
        onEvent:event=>{
          if(closed||!routes.has(route))return;
          if(event.type==="render-applied"&&event.running&&event.missingFramesInBlock===0){
            route.receipt=event;route.resolve?.(event);
          }
          if(event.type==="fatal-error"){
            route.failure=Error(event.message);route.reject?.(route.failure);
          }
          if(t.route!==route||!connected)return;
          if(event.type==="progress"||event.type==="render-applied"){
            updateFrame(t,route,event.sourceFrame);
            if(event.type==="progress")t.ended=!!event.ended;
            report({...event,axis:t.name,axisSourceFrame:t.frame});
          }else if(event.type==="fatal-error"){
            route.node.gain.value=0;report({...event,axis:t.name});
          }
        }});
      ensure();if(route.failure)throw route.failure;
      route.bridge.connect(route.node);route.node.connect(t.gain);
      return route;
    }catch(error){release(route);throw error;}
  }
  async function startReady(route){
    let timer;
    try{
      await route.bridge.play();
      if(route.failure)throw route.failure;
      if(!route.receipt&&!route.paused)await new Promise((resolve,reject)=>{
        route.resolve=resolve;route.reject=reject;
        timer=setTimeout(()=>reject(Error("往復参照の音声出力準備を確認できません")),2500);
      });
      ensure();if(route.failure)throw route.failure;
    }finally{clearTimeout(timer);route.resolve=null;route.reject=null;}
  }
  const setup=async(name,signal,processingMode,value)=>{
    const axisLength=signalLength(signal);
    const config={frame:0,speed:1,repeat:false,rangeStartFrame:0,rangeEndFrame:axisLength,
      loopStyle:"repeat",returning:false,...positions[name]};
    const source=axisSource({...signal,sourceFrames:axisLength},config,processingMode),plan=source.plan;
    const gain=ctx.createGain();gain.gain.value=value;nodes.push(gain);
    const level=name==="wet"?ctx.createGain():null;
    if(level){level.gain.value=1;gain.connect(level);nodes.push(level);}
    const t={name,signal:{...signal,sourceFrames:axisLength},config,anchor:plan.anchor,frame:plan.frame,returning:config.returning,
      ended:false,gain,level,processingMode,route:null};
    tracks[name]=t;
    t.route=await prepareRoute(t,config,source);
    t.route.node.gain.value=1;updateFrame(t,t.route,source.frame);
    if(name==="wet")applyCalibration(true);
  };
  function dispose(){if(closed)return;closed=true;for(const route of [...routes])release(route);for(const node of nodes)node.disconnect();progressiveWet?.dispose();}
  try{await setup("source",dry,"raw",gains[0]);await setup("wet",wet,mode==="wet-spectral"?"pv":"raw",gains[1]);}
  catch(error){dispose();throw error;}
  async function configure(name,config){
    ensure();if(!tracks[name])throw Error("参照軸がありません");
    const t=tracks[name],axisLength=signalLength(t.signal),next={...t.config,frame:state()[name].frame,returning:t.returning,...config};
    next.frame=Math.min(axisLength,Math.max(0,Math.round(next.frame)));
    let source=axisSource(t.signal,next,t.processingMode),plan=source.plan;
    const prior=t.config,priorPlan=axisPlan({...prior,frame:Math.round(state()[name].frame)},axisLength,sr,t.processingMode);
    const old=t.route;
    const sameReader=!!old.reader===!!source.reader&&(!old.reader||
      old.reader.startFrame===source.reader.startFrame&&old.reader.endFrame===source.reader.endFrame);
    if(!sameReader){
      // Stage only this axis. The other Worklet is never paused or recreated.
      // Keep original output active until the new Worklet has rendered PCM.
      let candidate;
      try{
        candidate=await prepareRoute(t,next,source);
        stagedRoutes.add(candidate);
        if(!Object.hasOwn(config,"frame")){
          next.frame=Math.min(axisLength,Math.max(0,Math.round(state()[name].frame)));
          next.returning=t.returning;source=axisSource(t.signal,next,t.processingMode);plan=source.plan;
          const needsReseek=source.frame!==candidate.bridge.latest?.sourceFrame;
          if(needsReseek)await candidate.bridge.seek(source.frame);
          if(!source.reader&&plan.frozen&&t.processingMode==="raw"){
            await candidate.bridge.setLoopConfiguration(source.a,source.b,source.loop);
            await candidate.bridge.scrub(plan.frame,plan.speed);
          }
        }
        if(running)await startReady(candidate);
        let candidateFrame=candidate.receipt?.sourceFrame??source.frame;
        // Stop or a seek may have moved the installed axis while this candidate waited for readiness.
        if(!Object.hasOwn(config,"frame")){
          next.frame=Math.min(axisLength,Math.max(0,Math.round(state()[name].frame)));
          next.returning=t.returning;source=axisSource(t.signal,next,t.processingMode);plan=source.plan;
          if(source.frame!==candidate.bridge.latest?.sourceFrame){
            const receipt=await candidate.bridge.seek(source.frame);
            candidateFrame=receipt?.sourceFrame??candidate.bridge.latest?.sourceFrame??source.frame;
          }else candidateFrame=candidate.bridge.latest?.sourceFrame??source.frame;
        }
        ensure();
        t.route=candidate;t.config=next;t.anchor=plan.anchor;t.ended=false;
        updateFrame(t,candidate,candidateFrame);
        if(running){
          const now=ctx.currentTime,end=now+.025;
          old.node.gain.setValueAtTime(1,now);old.node.gain.linearRampToValueAtTime(0,end);
          candidate.node.gain.setValueAtTime(0,now);candidate.node.gain.linearRampToValueAtTime(1,end);
          await new Promise(resolve=>setTimeout(resolve,40));
        }else candidate.node.gain.value=1;
        release(old);report({type:"axis-accepted",axis:name});return {sourceFrame:t.frame};
      }catch(error){if(candidate&&candidate!==t.route)release(candidate);throw error;}
      finally{if(candidate)stagedRoutes.delete(candidate);}
    }
    let receipt;
    if(old.reader){
      const loopChanged=plan.loop!==priorPlan.loop||plan.a!==priorPlan.a||plan.b!==priorPlan.b;
      const rawFreeze=t.processingMode==="raw"&&(plan.frozen||priorPlan.frozen);
      if(loopChanged)receipt=await old.bridge.setLoopConfiguration(plan.a,plan.b,plan.loop);
      if(Object.hasOwn(config,"frame")||rawFreeze&&(plan.frozen!==priorPlan.frozen||loopChanged))
        receipt=await old.bridge.scrub(Math.min(axisLength-1,plan.frame),plan.speed);
      else if(plan.speed!==priorPlan.speed)receipt=await old.bridge.setSpeed(plan.speed);
    }else{
      const loopChanged=plan.loop!==priorPlan.loop||plan.a!==priorPlan.a||plan.b!==priorPlan.b;
      const rawFreeze=t.processingMode==="raw"&&(plan.frozen||priorPlan.frozen);
      if(loopChanged)receipt=await old.bridge.setLoopConfiguration(plan.a,plan.b,plan.loop);
      if(Object.hasOwn(config,"frame")||rawFreeze&&(plan.frozen!==priorPlan.frozen||loopChanged))
        receipt=await old.bridge.scrub(Math.min(axisLength-1,plan.frame),plan.speed);
      else if(plan.speed!==priorPlan.speed)receipt=await old.bridge.setSpeed(plan.speed);
    }
    if(receipt?.stale)return receipt;
    t.config=next;
    if(plan.frozen)t.anchor=t.processingMode==="raw"?plan.anchor:receipt?.sourceFrame??t.frame;
    if(receipt){updateFrame(t,old,receipt.sourceFrame);t.ended=false;}
    report({type:"axis-accepted",axis:name});return receipt;
  }
  return {
    connect(destination){for(const t of Object.values(tracks))(t.level??t.gain).connect(destination);connected=true;},
    async play(){await Promise.all(Object.values(tracks).map(t=>t.route.bridge.play()));running=true;report({type:"pair-accepted"});},
    async pause(){const active=Object.values(tracks),activeRoutes=new Set(active.map(t=>t.route));
      const staged=[...stagedRoutes].filter(route=>routes.has(route)&&!activeRoutes.has(route));
      const receipts=await Promise.all([
        ...active.map(t=>t.route.bridge.pause()),
        ...staged.map(route=>route.bridge.pause().catch(error=>{if(routes.has(route))throw error;return null;}))
      ]);
      active.forEach((t,i)=>updateFrame(t,t.route,receipts[i].sourceFrame));running=false;
      staged.forEach(route=>{route.paused=true;route.resolve?.(null);});
      report({type:"pair-accepted"});return {sourceFrame:state().source.frame};},
    async seek(frame){await Promise.all(["source","wet"].map(name=>
      configure(name,{frame:Math.min(signalLength(tracks[name].signal),frame)})));return {sourceFrame:state().source.frame};},
    configure,dispose,get axes(){return state();},get calibration(){return calibrationState();},
    setCalibration(mode){ensure();wetCalibration=validateCalibration(mode);applyCalibration(true);report({type:"axis-accepted",axis:"wet"});return true;},
    setMix(mix,solo){const values=scrubGains(mix,solo);Object.values(tracks).forEach((t,i)=>t.gain.gain.setTargetAtTime(values[i],ctx.currentTime,.005));}
  };
}
