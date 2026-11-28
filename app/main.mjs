import {makeSource,makeIR,readLocalAudio} from "../src/materials.mjs";
import {prepareComparison} from "../src/comparison-session.mjs";
import {createPreviewPlayer} from "../src/preview-player.mjs";
import {createIRSpectralWorker} from "../src/ir-spectral-worker.mjs";
import {isScrubMode} from "../src/scrub-pair.mjs";
import {secondsToFrames} from "../src/convolution.mjs";
import {createWetMixBinding,mountWetMixField} from "../src/wet-mix.mjs";
import {createSourceWaveView} from "./source-wave-view.mjs";
import {createIRWaveView} from "./ir-wave-view.mjs";
import {openProgressiveMaterial,estimatePreparedComparisonBytes,resamplePCM} from "../src/progressive-material.mjs";
import {createProgressiveSession} from "../src/progressive-session.mjs";
const $=id=>document.getElementById(id);
let ctx,player,session,mode="dry",appliedMode="dry",busy=false,seeking=false,sourceFile=null,irFile=null;
let sourceFileRevision=0,preparationRevision=0,preparationWork=null,queuedPreparation=null;
const fileReadRevision={source:0,ir:0};
const nativeSourceCache=new WeakMap();
let activeWaveSource=null,activeSourceReader=null,activeIRSource=null,activeIRKey=null;
let appliedSourceKey=null,appliedSourceType="impulse",stopRevision=0,wetApplyTimer=null;
let explicitStopIntent=false,stopping=false;
const status=$("status"),seek=$("seek");
let savedAxes={};const dragging=new Set();
let pendingWave=null,waveSeekWork=false;
const wave=createSourceWaveView({
  getFrame:()=>isScrubMode(appliedMode)?player?.state.axes?.source?.frame??0:player?.state.position??0,
  getRange:()=>isScrubMode(appliedMode)?player?.state.axes?.source:null,
  onSeek:frame=>{if(!session)return;pendingWave={session,mode:appliedMode,frame};pumpWave();},
  onRange:(edge,frame)=>{
    if(!session||!isScrubMode(appliedMode))return;
    pendingWave={session,mode:appliedMode,edge,frame};pumpWave();
  }
});
const irWave=createIRWaveView({
  getWindow:irWaveRange,
  canEdit:()=>!!session&&(!busy||windowApplying)&&appliedMode==="ir-window",
  onStart:seconds=>{
    const rate=session?.irSampleRate??session?.ir?.sampleRate??48000;
    const frames=session?.irFrames??session?.ir?.channels?.[0]?.length??0;
    const length=Math.max(1,Math.round(Number($("ir-window-length").value||1)*rate/1000));
    const start=Math.max(0,Math.min(Math.max(0,frames-length),Math.round(seconds*rate)));
    $("ir-window-start").value=String(start*1000/rate);
    requestWindow();
  },
  onEdge:(edge,frame)=>{
    const rate=session?.irSampleRate??session?.ir?.sampleRate??48000;
    const frames=session?.irFrames??session?.ir?.channels?.[0]?.length??0;
    const range=irWaveRange();
    if(edge==="a"){
      const start=Math.max(0,Math.min(Math.max(0,frames-1),Math.min(frame,range.end-1)));
      $("ir-window-start").value=String(start*1000/rate);
      $("ir-window-length").value=String((range.end-start)*1000/rate);
    }else if(edge==="b"){
      const end=Math.max(range.start+1,Math.min(frames,frame));
      $("ir-window-length").value=String((end-range.start)*1000/rate);
    }
    requestWindow();
  }
});
function irWaveRange(){
  const rate=session?.irSampleRate??session?.ir?.sampleRate??48000;
  const frames=session?.irFrames??session?.ir?.channels?.[0]?.length??0;
  const start=Math.max(0,Math.min(Math.max(0,frames-1),Math.round(Number($("ir-window-start").value||0)*rate/1000)));
  const length=Math.max(1,Math.round(Number($("ir-window-length").value||1)*rate/1000));
  return {start,end:Math.min(frames,start+length)};
}
function pumpWave(){
  if(busy||waveSeekWork||!pendingWave)return;
  const job=pendingWave;pendingWave=null;
  if(job.session!==session||job.mode!==appliedMode){wave.refresh(true);return;}
  waveSeekWork=true;
  void run(async()=>{
    if(job.edge){
      const current=player.state.axes.source;
      const frame=Math.min(session.length,Math.max(0,job.frame));
      const start=job.edge==="a"?Math.min(frame,session.length-1):Math.max(0,Math.min(current.rangeStartFrame,frame-1));
      const end=job.edge==="b"?Math.max(1,frame):Math.min(session.length,Math.max(current.rangeEndFrame,start+1));
      await player.configureAxis("source",{rangeStartFrame:start,rangeEndFrame:end});
      const axis=player.state.axes.source;
      $("source-range-start").value=String((session.interval.start+axis.rangeStartFrame)/session.sampleRate);
      $("source-range-end").value=String((session.interval.start+axis.rangeEndFrame)/session.sampleRate);
      showAxes(player.state.axes);
    }else if(isScrubMode(job.mode)){await player.configureAxis("source",{frame:job.frame});showAxes(player.state.axes);}
    else await player.seek(job.frame);
    show(player.state.position);
  }).finally(()=>{waveSeekWork=false;wave.refresh(true);pumpWave();});
}
let windowRevision=0,windowWork=null,queuedWindow=null,windowApplying=false;
const spectralWorker=createIRSpectralWorker();
const spectralFields=["ir-spectral-start","ir-spectral-speed","ir-spectral-length","ir-spectral-boundary",
  "ir-spectral-range-start","ir-spectral-range-end","ir-spectral-fft","ir-spectral-calibration","ir-spectral-scrub"];
function cancelWindowRequests(){++windowRevision;queuedWindow=null;}
function readNumber(id){
  const raw=$(id).value;
  if(!raw.trim()||!Number.isFinite(Number(raw)))throw Error("数値を入力してください: "+id);
  return Number(raw);
}
function readWindow(){
  return {start:readNumber("ir-window-start")/1000,duration:readNumber("ir-window-length")/1000,calibration:$("ir-calibration").value};
}
function showWindow(next,{latest=true}={}){
  $("gain").textContent="共通出力ゲイン "+next.gain.applied.toFixed(4)+"（安全減衰を含む）";
  const range=next.irWindow,irSampleRate=next.irSampleRate??next.sampleRate;
  $("window-range").textContent="適用IR窓: "+(range.startFrame/irSampleRate*1000).toFixed(3)+" – "+(range.endFrame/irSampleRate*1000).toFixed(3)+" ms"+(range.truncated?"（IR終端まで）":"")+
    (next.irCalibration==="compensated"?" / RMS補正 ×"+next.irScale.toFixed(3):" / 自然減衰");
  $("ir-window-scrub").max=String((next.irFrames-1)/irSampleRate*1000);
  $("ir-window-scrub").value=$("ir-window-start").value;
  if(latest)$("window-request").textContent=$("ir-window-start").value+" ms";
  const selected=irWaveRange();
  $("ir-wave-selection").textContent=(selected.start/irSampleRate*1000).toFixed(3)+" – "+
    (selected.end/irSampleRate*1000).toFixed(3)+" ms";
  irWave.refresh(true);
}
function readSpectral(){
  const frames=id=>secondsToFrames(readNumber(id)/1000,session.sampleRate);
  const fftFrames=readNumber("ir-spectral-fft");
  return {startFrame:frames("ir-spectral-start"),speed:readNumber("ir-spectral-speed"),
    outputFrames:frames("ir-spectral-length"),boundary:$("ir-spectral-boundary").value,
    loopStartFrame:frames("ir-spectral-range-start"),loopEndFrame:frames("ir-spectral-range-end"),
    fftFrames,hopFrames:fftFrames/8,calibration:$("ir-spectral-calibration").value};
}
function showSpectral(next,{reset=false,latest=true}={}){
  const s=next.irSpectral,ms=frame=>frame*1000/next.sampleRate;
  const requested=queuedWindow?.mode==="ir-spectral"?{
    start:$("ir-spectral-start").value,speed:$("ir-spectral-speed").value,
    length:$("ir-spectral-length").value,boundary:$("ir-spectral-boundary").value,
    rangeStart:$("ir-spectral-range-start").value,rangeEnd:$("ir-spectral-range-end").value,
    fft:$("ir-spectral-fft").value,calibration:$("ir-spectral-calibration").value
  }:null;
  if(reset){
    for(const id of ["ir-spectral-start","ir-spectral-scrub"])$(id).max=String(ms(next.irFrames-1));
    $("ir-spectral-range-end").max=String(ms(next.irFrames));
    $("ir-spectral-range-start").max=String(ms(next.irFrames-1));
    $("ir-spectral-start").value=requested?.start??String(ms(s.startFrame));
    $("ir-spectral-scrub").value=$("ir-spectral-start").value;
    $("ir-spectral-speed").value=requested?.speed??String(s.speed);
    $("ir-spectral-length").value=requested?.length??String(ms(s.outputFrames));
    $("ir-spectral-boundary").value=requested?.boundary??s.boundary;
    $("ir-spectral-range-start").value=requested?.rangeStart??String(ms(s.loopStartFrame));
    $("ir-spectral-range-end").value=requested?.rangeEnd??String(ms(s.loopEndFrame));
    $("ir-spectral-fft").value=requested?.fft??String(s.fftFrames);
    $("ir-spectral-calibration").value=requested?.calibration??next.irSpectralCalibration;
  }
  if(latest)$("ir-spectral-request").textContent=requested?
    "計算要求: "+requested.start+" ms / "+requested.speed+"×":"適用済み";
  $("ir-spectral-applied").textContent="適用IR: "+ms(s.startFrame).toFixed(3)+" ms / "+s.speed+"× / "+
    ms(s.outputFrames).toFixed(3)+" ms / "+s.boundary+" / "+s.algorithm+
    (next.irSpectralCalibration==="compensated"?" / RMS補正 ×"+next.irSpectralScale.toFixed(3):" / 自然減衰");
}
function requestWindow(kind="ir-window"){
  if(!session||mode!==kind)return;
  try{
    const settings=kind==="ir-spectral"?readSpectral():readWindow();
    queuedWindow={revision:++windowRevision,settings,mode:kind};
    if(kind==="ir-window"){
      const range=irWaveRange(),rate=session.irSampleRate??session.ir?.sampleRate??
        activeIRSource?.sampleRate??session.sampleRate;
      $("ir-wave-selection").textContent=(range.start/rate*1000).toFixed(3)+" – "+
        (range.end/rate*1000).toFixed(3)+" ms（要求）";
      irWave.refresh(true);
    }
    if(kind==="ir-window")$("window-request").textContent=(settings.start*1000).toFixed(3)+" ms（要求）";
    else $("ir-spectral-request").textContent="計算要求: "+$("ir-spectral-start").value+" ms / "+settings.speed+"×";
    message((kind==="ir-spectral"?"IR再合成":"IR窓")+"を計算中…（旧音を維持）");
    pumpWindow();
  }catch(error){cancelWindowRequests();message("IRを更新できません: "+error.message);}
}
function pumpWindow(){
  if(busy||preparationWork||queuedPreparation||windowWork||!queuedWindow)return;
  const job=queuedWindow;queuedWindow=null;
  windowWork=(async()=>{
    try{
      const base=session;
      const next=job.mode==="ir-spectral"?
        await base.withIRSpectral(job.settings,spectralWorker.render):
        await base.withIRWindow(job.settings);
      if(job.revision!==windowRevision||mode!==job.mode)return;
      if(busy){if(!queuedWindow)queuedWindow=job;return;}
      windowApplying=true;
      try{
        await run(async()=>{
          if(job.revision!==windowRevision||mode!==job.mode)return;
          const accepted=await player.load(next.select(mode,binding.value,$("solo").value),next.gain.applied,{crossfade:true});
          if(!accepted)return;
          session=next;pendingWave=null;syncComparisonRange(next);wave.setInterval(next);
          showWindow(next,{latest:job.mode==="ir-window"&&job.revision===windowRevision});
          if(!next.progressive)showSpectral(next,{latest:job.mode==="ir-spectral"&&job.revision===windowRevision});show(player.state.position);
          if(job.revision===windowRevision)message(job.mode==="ir-spectral"?"IR再合成を適用":"IR窓を適用: "+next.irCalibration);
        });
      }finally{windowApplying=false;controls();}
    }catch(error){if(job.revision===windowRevision)message((job.mode==="ir-spectral"?"IR再合成":"IR窓")+"を更新できません: "+error.message);}
  })().finally(()=>{windowWork=null;pumpWindow();pumpPreparation();});
}
function showAxes(axes){
  if(!axes||!session)return;
  for(const name of ["source","wet"]){
    const axis=axes[name];if(!axis)continue;
    savedAxes[name]={frame:Math.round(axis.frame),speed:axis.speed,repeat:axis.repeat,
      rangeStartFrame:axis.rangeStartFrame,rangeEndFrame:axis.rangeEndFrame,loopStyle:axis.loopStyle,returning:axis.returning};
    const seconds=frame=>(session.interval.start+frame)/session.sampleRate;
    $(name+"-range-applied").textContent=(axis.repeat?(axis.loopStyle==="pingpong"?"往復中: ":"反復中: "):"反復範囲: ")+
      seconds(axis.rangeStartFrame).toFixed(4)+" – "+seconds(axis.rangeEndFrame).toFixed(4)+" s";
    if(!dragging.has(name)){
      $(name+"-seek").value=String(Math.round(axis.frame));
      $(name+"-position").textContent=((session.interval.start+axis.frame)/session.sampleRate).toFixed(3)+" s";
    }
  }
}
function showCalibration(value){
  if(!value)return;
  $("wet-calibration-applied").textContent=value.mode==="compensated"?
    "Wet補正目標 ×"+value.targetScale.toFixed(3):"Wet自然減衰 ×1";
}
function message(s){status.textContent=s;}
function controls(){
  for(const id of ["source","source-file","ir","ir-file","frequency","ir-length","predelay","ir-window-start","ir-window-length","ir-calibration","prepare","wet","solo"])$(id).disabled=busy;
  for(const b of document.querySelectorAll("[data-mode]")){b.disabled=busy||!session||(session.progressive&&!['dry','normal','ir-window'].includes(b.dataset.mode));b.setAttribute("aria-pressed",String(b.dataset.mode===appliedMode));}
  $("play").disabled=busy||!session||stopping;
  for(const id of ["pause","seek"])$(id).disabled=busy||!session;
  $("stop").disabled=!session;
  $("ir-live").hidden=appliedMode!=="ir-window";
  $("ir-spectral-live").hidden=appliedMode!=="ir-spectral";
  for(const id of spectralFields)$(id).disabled=(busy&&!windowApplying)||!session||appliedMode!=="ir-spectral";
  $("ir-window-scrub").disabled=(busy&&!windowApplying)||!session||appliedMode!=="ir-window";
  if(windowApplying)for(const id of ["ir-window-start","ir-window-length","ir-calibration"])$(id).disabled=false;
  $("scrub-axes").hidden=!isScrubMode(appliedMode);
  $("wet-calibration").disabled=busy||!session||!isScrubMode(appliedMode);
  for(const name of ["source","wet"])for(const suffix of ["seek","speed","repeat","range-start","range-end","loop-style"])
    $(name+"-"+suffix).disabled=busy||!session||!isScrubMode(appliedMode);
}
function syncComparisonRange(next,{reset=false}={}){
  seek.max=String(next.length);
  const a=next.interval.start/next.sampleRate,b=next.interval.end/next.sampleRate;
  for(const name of ["source","wet"]){
    $(name+"-seek").max=String(next.length-1);
    for(const suffix of ["range-start","range-end"]){
      $(name+"-"+suffix).min=String(a);$(name+"-"+suffix).max=String(b);
    }
    if(reset||!savedAxes[name]){
      $(name+"-range-start").value=String(a);$(name+"-range-end").value=String(b);
    }
  }
}
function show(frame){
  if(!session)return;
  if(!seeking)seek.value=String(Math.min(session.length,Math.max(0,Math.round(frame))));
  $("time").textContent=((session.interval.start+frame)/session.sampleRate).toFixed(3)+" s";
}
async function run(fn){
  if(busy)return;busy=true;controls();
  try{await fn();}catch(e){message("処理できません: "+e.message);}
  finally{busy=false;controls();pumpWindow();pumpWave();pumpPreparation();flushWetApply();}
}
async function audio(){
  if(!ctx){ctx=new AudioContext();player=createPreviewPlayer(ctx,{onState:s=>{
    if(s.error){message("再生エラー: "+s.error);return;}
    show(s.position);showAxes(s.axes);showCalibration(s.calibration);wave.refresh();
    if(s.event?.type==="render-applied"&&s.event.missingFramesInBlock===0)
      status.dataset.renderApplied=String(s.event.requestId);
    if(s.event?.type==="progress")status.dataset.renderedFrames=String(s.event.renderedFrames);
  }});}
  player.setVolume(Number($("master-volume").value)/100);
  await ctx.resume();
}
const binding=createWetMixBinding();
let wetApplyRequested=false;
function scheduleWetApply(){
  if(!session)return;
  wetApplyRequested=true;
  clearTimeout(wetApplyTimer);
  wetApplyTimer=null;
  if(document.activeElement===$("wet"))return;
  wetApplyTimer=setTimeout(()=>{wetApplyTimer=null;flushWetApply();},120);
}
function flushWetApply(){
  if(document.activeElement===$("wet"))return;
  if(!wetApplyRequested||busy||!session)return;
  wetApplyRequested=false;
  void run(()=>choose(mode));
}
function applyPendingWetEdit(){if(wetApplyRequested)scheduleWetApply();}
mountWetMixField({field:$("wet"),binding,onChanged:scheduleWetApply});
$("wet").addEventListener("blur",applyPendingWetEdit);
async function loadMode(target,next,options={}){
  if(isScrubMode(next)){
    const positions=options.reset?{}:{...savedAxes,
      source:{...savedAxes.source,frame:Math.round(player.state.position)}};
    return await player.load(target.signals.dry,target.gain.applied,{...options,
      scrub:{wet:target.signals.normal,mode:next,mix:binding.value,solo:$("solo").value,calibration:$("wet-calibration").value},positions});
  }else return await player.load(target.select(next,binding.value,$("solo").value),target.gain.applied,options);
}
async function choose(next){
  if(!session)return;
  if(next!==mode){cancelWindowRequests();if(mode==="ir-spectral")spectralWorker.cancel();}
  await audio();
  if((next!==mode||!isScrubMode(next)||!player.setMix(binding.value,$("solo").value))&&
     !await loadMode(session,next))return;
  if(isScrubMode(next)){showAxes(player.state.axes);showCalibration(player.state.calibration);}
  mode=appliedMode=next;pendingWave=null;wave.refresh(true);
  message("適用: "+mode+" / Wet "+(binding.value*100).toFixed(3)+"%");
  show(player.state.position);
}
function preparationJob(revision){
  const sourceType=$("source").value,irType=$("ir").value;
  const frequency=Number($("frequency").value),irLength=Number($("ir-length").value);
  const source=sourceType==="file"?sourceFile:makeSource(sourceType,{frequency});
  const ir=irType==="file"?irFile:makeIR(irType,{seconds:irLength});
  if(!source||!ir)throw Error("素材を選択してください");
  const predelay=readNumber("predelay")/1000,irWindow=readWindow();
  return {revision,source,ir,predelay,irWindow,sourceType,
    sourceKey:sourceType==="file"?"file:"+sourceFileRevision:`${sourceType}:${frequency}`,
    irKey:irType==="file"?"file:"+fileReadRevision.ir:`${irType}:${irLength}`};
}
function requestPreparation(){
  const revision=++preparationRevision;
  queuedPreparation=null;cancelWindowRequests();spectralWorker.cancel();
  let job;
  try{job=preparationJob(revision);}
  catch(error){message("比較音を更新できません: "+error.message);return;}
  queuedPreparation=job;
  message("比較音を更新中…（適用中の音を維持）");
  // Create/resume the player while the control change still has user activation.
  if(!player)void audio().catch(error=>{if(revision===preparationRevision)message("再生機構を初期化できません: "+error.message);});
  pumpPreparation();
}
function pumpPreparation(){
  if(preparationWork||windowWork||!queuedPreparation)return;
  const job=queuedPreparation;queuedPreparation=null;
  preparationWork=(async()=>{
    try{
      let next;
      if(job.source?.read){
        const estimate=estimatePreparedComparisonBytes({sourceFrames:job.source.sourceFrames,
          sourceSampleRate:job.source.sampleRate,sourceChannels:job.source.channelCount,
          irFrames:job.ir.channels[0].length,irSampleRate:job.ir.sampleRate,irChannels:job.ir.channels.length,
          processingRate:job.ir.sampleRate,delaySeconds:job.predelay});
        if(estimate.withinBudget){
          if(!job.source.file)throw Error("短尺音源を既存デコーダで準備できません");
          const reader=job.source;
          let cached=nativeSourceCache.get(reader);
          if(!cached||cached.sampleRate!==job.ir.sampleRate){
            let pcm=await readLocalAudio(reader.file);pcm=await resamplePCM(pcm,job.ir.sampleRate);
            cached={sampleRate:job.ir.sampleRate,pcm};nativeSourceCache.set(reader,cached);
          }
          const pcm=cached.pcm;
          if(job.revision!==preparationRevision)return;
          job.waveSource=pcm;
          next=await prepareComparison(pcm,job.ir,{predelay:job.predelay,irWindow:job.irWindow});
        }else{
          if(job.source.canReadPCM===false)
            throw Error("この長さの音源は逐次デコードできません。対応codecの音源か短い音源を選んでください");
          job.waveSource=job.source;
          next=createProgressiveSession(job.source,job.ir,{predelay:job.predelay,irWindowSettings:job.irWindow});
        }
      }else{job.waveSource=job.source;next=await prepareComparison(job.source,job.ir,{predelay:job.predelay,irWindow:job.irWindow});}
      if(job.revision!==preparationRevision)return;
      await applyPreparation(job,next);
    }catch(error){if(job.revision===preparationRevision){
      if(job.sourceKey!==appliedSourceKey)$("source").value=appliedSourceType;
      message("比較音を更新できません: "+error.message);
    }}
  })().finally(()=>{
    preparationWork=null;
    if(queuedPreparation&&!busy)pumpPreparation();
    else if(!busy)pumpWindow();
  });
}
async function applyPreparation(job,next){
  if(job.revision!==preparationRevision)return;
  if(busy){queuedPreparation=job;return;}
  await run(async()=>{
    if(job.revision!==preparationRevision)return;
    const stopToken=stopRevision,sourceChanged=job.sourceKey!==appliedSourceKey;
    const stoppedSinceRequest=explicitStopIntent;
    const wasRunning=!stoppedSinceRequest&&!!player?.state.running;
    const previousFrame=Math.round(player?.state.position??0);
    let frame=sourceChanged||stoppedSinceRequest?0:previousFrame;
    if(!sourceChanged&&!stoppedSinceRequest&&session&&next.sampleRate>0){
      const sourceTime=(session.interval.start+previousFrame)/session.sampleRate;
      frame=Math.round(sourceTime*next.sampleRate-next.interval.start);
      frame=Math.max(0,Math.min(next.length,frame));
    }
    await audio();
    if(job.revision!==preparationRevision)return;
    if(next.progressive&&next.processingRate!==ctx.sampleRate)
      next=next.withProcessingRate(ctx.sampleRate);
    const resume=wasRunning&&stopRevision===stopToken;
    let nextMode=mode,fallbackReason="";
    if(next.progressive&&!['dry','normal','ir-window'].includes(nextMode)){
      nextMode=job.predelay<0?"dry":"normal";
      fallbackReason=`長尺音源では${mode}が未対応のため${nextMode==="dry"?"Dry":"Normal"}へ切替`;
    }
    if(next.progressive&&job.predelay<0&&["normal","ir-window"].includes(nextMode)){
      nextMode="dry";
      fallbackReason="長尺音源の負Predelayは先読み処理が未実装のためDryへ切替";
    }
    let accepted=await loadMode(next,nextMode,{frame,resume,reset:true});
    if(!accepted&&stopRevision!==stopToken)
      accepted=await loadMode(next,nextMode,{frame:0,resume:false,reset:true});
    if(!accepted)return;
    if(stopRevision!==stopToken)await player.stop();
    mode=appliedMode=nextMode;
    wetApplyRequested=false;clearTimeout(wetApplyTimer);wetApplyTimer=null;
    const priorProgressive=session?.progressive?session.source:null;
    const priorReader=activeSourceReader,waveSourceChanged=sourceChanged||activeWaveSource!==job.waveSource;
    session=next;appliedSourceKey=job.sourceKey;appliedSourceType=job.sourceType;savedAxes={};pendingWave=null;
    activeWaveSource=job.waveSource;
    activeSourceReader=job.sourceType==="file"&&typeof job.source?.read==="function"?job.source:null;
    if(queuedWindow?.mode==="ir-spectral")queuedWindow={...queuedWindow,settings:readSpectral()};
    syncComparisonRange(next,{reset:true});show(player.state.position);
    if(waveSourceChanged)wave.setSource(job.waveSource,next);else wave.setInterval(next);
    if(activeIRKey!==job.irKey){activeIRKey=job.irKey;irWave.setIR(job.ir);}
    else irWave.refresh(true);
    activeIRSource=job.ir;
    if(next.progressive&&job.source?.read)nativeSourceCache.delete(job.source);
    if(priorReader&&priorReader!==activeSourceReader){
      nativeSourceCache.delete(priorReader);
      if(priorReader!==sourceFile)priorReader.dispose();
    }
    else if(priorProgressive&&priorProgressive!==next.source&&priorProgressive!==sourceFile)
      priorProgressive.dispose();
    for(const name of ["source","wet"]){
      $(name+"-speed").value="1";$(name+"-repeat").checked=false;$(name+"-loop-style").value="repeat";
    }
    showAxes(player.state.axes);showCalibration(player.state.calibration);
    showWindow(next);if(!next.progressive)showSpectral(next,{reset:true});
    message(fallbackReason?`準備済み: ${fallbackReason}。長尺逐次再生 / Dry・Normal・IR Window（他方式は未対応）`:
      next.progressive?"準備済み: 長尺逐次再生 / Dry・Normal・IR Window（他方式は未対応）":"準備済み: "+mode);status.dataset.prepared="true";
  });
}
$("prepare").onclick=requestPreparation;
$("source").onchange=()=>{fileReadRevision.source++;requestPreparation();};
$("ir").onchange=()=>{fileReadRevision.ir++;requestPreparation();};
$("frequency").onchange=()=>{if($("source").value!=="file")requestPreparation();};
$("ir-length").onchange=()=>{if($("ir").value!=="file")requestPreparation();};
$("predelay").onchange=requestPreparation;
for(const [id,select,set] of [["source-file","source",v=>sourceFile=v],["ir-file","ir",v=>irFile=v]]){
  $(id).onchange=async()=>{
    const revision=++fileReadRevision[select];
    const file=$(id).files?.[0];if(!file)return;
    // Keep AudioContext activation inside the user-selected file gesture.
    if(!player)void audio().catch(()=>{});
    try{
      const data=select==="source"?await openProgressiveMaterial(file):await readLocalAudio(file);
      if(revision!==fileReadRevision[select])return;
      set(data);
      if(select==="source")sourceFileRevision++;
      const opt=$(select).querySelector('[value="file"]');opt.disabled=false;$(select).value="file";
      requestPreparation();
    }catch(error){if(revision===fileReadRevision[select])message(file.name+" を読み込めません: "+error.message);}
    finally{if(revision===fileReadRevision[select])$(id).value="";}
  };
}
for(const button of document.querySelectorAll("[data-mode]"))button.onclick=()=>run(()=>choose(button.dataset.mode));
$("master-volume").oninput=()=>{
  const value=Number($("master-volume").value);
  $("master-volume-value").textContent=value.toFixed(1).replace(/\.0$/,"")+"%";
  player?.setVolume(value/100);
};
$("solo").onchange=()=>run(()=>choose(mode));
$("play").onclick=()=>{
  explicitStopIntent=false;
  void run(async()=>{
    const intent=stopRevision;
    await audio();if(intent!==stopRevision)return;
    if(!isScrubMode(mode)&&player.state.position>=session.length)await player.seek(0);
    if(intent!==stopRevision)return;
    if(!await player.play())return;
    if(intent!==stopRevision){await player.stop();return;}
    message("再生要求を受理");
  });
};
$("pause").onclick=()=>{
  void run(async()=>{await player.pause();message("一時停止");});
};
$("stop").onclick=()=>{
  if(!player)return;
  explicitStopIntent=true;stopping=true;controls();
  const request=++stopRevision;
  void player.stop().then(()=>{
    if(request!==stopRevision)return;
    show(0);message("先頭");
  }).catch(error=>{if(request===stopRevision)message("停止できません: "+error.message);})
    .finally(()=>{if(request===stopRevision){stopping=false;controls();}});
};
seek.addEventListener("input",()=>{seeking=true;show(Number(seek.value));});
seek.addEventListener("change",()=>{const frame=Number(seek.value);seeking=false;void run(()=>player.seek(frame));});
for(const name of ["source","wet"]){
  const slider=$(name+"-seek"),speed=$(name+"-speed"),repeat=$(name+"-repeat");
  slider.oninput=()=>{dragging.add(name);$(name+"-position").textContent=((session.interval.start+Number(slider.value))/session.sampleRate).toFixed(3)+" s（要求）";};
  slider.onchange=()=>{const frame=Number(slider.value);dragging.delete(name);void run(async()=>{await player.configureAxis(name,{frame});showAxes(player.state.axes);});};
  speed.onchange=()=>run(async()=>{if(!speed.value.trim())throw Error("速度を入力してください");await player.configureAxis(name,{speed:Number(speed.value)});showAxes(player.state.axes);});
  const applyRange=()=>run(async()=>{
    const toFrame=id=>secondsToFrames(readNumber(id),session.sampleRate)-session.interval.start;
    await player.configureAxis(name,{repeat:repeat.checked,loopStyle:$(name+"-loop-style").value,
      rangeStartFrame:toFrame(name+"-range-start"),rangeEndFrame:toFrame(name+"-range-end")});
    showAxes(player.state.axes);message(name+" の反復区間を適用");
  });
  // Disabling repeat must not depend on the validity of the edited draft.
  repeat.onchange=()=>repeat.checked?applyRange():run(async()=>{
    await player.configureAxis(name,{repeat:false});
    showAxes(player.state.axes);message(name+" の反復を解除");
  });
  $(name+"-range-start").onchange=applyRange;$(name+"-range-end").onchange=applyRange;
  $(name+"-loop-style").onchange=applyRange;
}
$("wet-calibration").onchange=()=>run(async()=>{
  if(!player.setCalibration($("wet-calibration").value))throw Error("Wet独立参照方式を選択してください");
  showCalibration(player.state.calibration);
});
$("ir-window-scrub").oninput=()=>{$("ir-window-start").value=$("ir-window-scrub").value;requestWindow();};
for(const id of ["ir-window-start","ir-window-length","ir-calibration"])$(id).onchange=()=>requestWindow();
$("ir-spectral-scrub").oninput=()=>{$("ir-spectral-start").value=$("ir-spectral-scrub").value;requestWindow("ir-spectral");};
for(const id of spectralFields.filter(id=>id!=="ir-spectral-scrub"))$(id).onchange=()=>{
  if(id==="ir-spectral-start")$("ir-spectral-scrub").value=$(id).value;
  requestWindow("ir-spectral");
};
window.addEventListener("pagehide",()=>{cancelWindowRequests();spectralWorker.dispose();wave.dispose();irWave.dispose();player?.dispose();void ctx?.close();},{once:true});
controls();
