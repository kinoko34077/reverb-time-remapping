import {makeSource,makeIR,readLocalWav} from "../src/materials.mjs";
import {prepareComparison} from "../src/comparison-session.mjs";
import {createPreviewPlayer} from "../src/preview-player.mjs";
import {isScrubMode} from "../src/scrub-pair.mjs";
import {secondsToFrames} from "../src/convolution.mjs";
import {createWetMixBinding,mountWetMixField} from "../src/wet-mix.mjs";
const $=id=>document.getElementById(id);
let ctx,player,session,mode="dry",appliedMode="dry",busy=false,seeking=false,sourceFile=null,irFile=null;
const status=$("status"),seek=$("seek");
let savedAxes={};const dragging=new Set();
let windowRevision=0,windowWork=null,queuedWindow=null,windowApplying=false;
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
  const range=next.irWindow;
  $("window-range").textContent="適用IR窓: "+(range.startFrame/next.sampleRate*1000).toFixed(3)+" – "+(range.endFrame/next.sampleRate*1000).toFixed(3)+" ms"+(range.truncated?"（IR終端まで）":"")+
    (next.irCalibration==="compensated"?" / RMS補正 ×"+next.irScale.toFixed(3):" / 自然減衰");
  $("ir-window-scrub").max=String((next.irFrames-1)/next.sampleRate*1000);
  $("ir-window-scrub").value=$("ir-window-start").value;
  if(latest)$("window-request").textContent=$("ir-window-start").value+" ms";
}
function requestWindow(){
  if(!session||mode!=="ir-window")return;
  try{
    const settings=readWindow();
    queuedWindow={revision:++windowRevision,base:session,settings};
    $("window-request").textContent=(settings.start*1000).toFixed(3)+" ms（要求）";
    message("IR窓を計算中…（旧音を維持）");
    pumpWindow();
  }catch(error){cancelWindowRequests();message("IR窓を更新できません: "+error.message);}
}
function pumpWindow(){
  if(busy||windowWork||!queuedWindow)return;
  const job=queuedWindow;queuedWindow=null;
  windowWork=(async()=>{
    try{
      const next=await job.base.withIRWindow(job.settings);
      if(job.revision!==windowRevision||mode!=="ir-window")return;
      if(busy){if(!queuedWindow)queuedWindow=job;return;}
      windowApplying=true;
      try{
        await run(async()=>{
          if(job.revision!==windowRevision||mode!=="ir-window")return;
          const accepted=await player.load(next.select(mode,binding.value,$("solo").value),next.gain.applied,{crossfade:true});
          if(!accepted)return;
          session=next;showWindow(next,{latest:job.revision===windowRevision});show(player.state.position);
          if(job.revision===windowRevision)message("IR窓を適用: "+next.irCalibration);
        });
      }finally{windowApplying=false;controls();}
    }catch(error){if(job.revision===windowRevision)message("IR窓を更新できません: "+error.message);}
  })().finally(()=>{windowWork=null;pumpWindow();});
}
function showAxes(axes){
  if(!axes||!session)return;
  for(const name of ["source","wet"]){
    const axis=axes[name];if(!axis)continue;
    savedAxes[name]={frame:Math.round(axis.frame),speed:axis.speed,repeat:axis.repeat,
      rangeStartFrame:axis.rangeStartFrame,rangeEndFrame:axis.rangeEndFrame};
    const seconds=frame=>(session.interval.start+frame)/session.sampleRate;
    $(name+"-range-applied").textContent=(axis.repeat?"反復中: ":"反復範囲: ")+
      seconds(axis.rangeStartFrame).toFixed(4)+" – "+seconds(axis.rangeEndFrame).toFixed(4)+" s";
    if(!dragging.has(name)){
      $(name+"-seek").value=String(Math.round(axis.frame));
      $(name+"-position").textContent=((session.interval.start+axis.frame)/session.sampleRate).toFixed(3)+" s";
    }
  }
}
function message(s){status.textContent=s;}
function controls(){
  for(const id of ["source","source-file","ir","ir-file","frequency","ir-length","predelay","ir-window-start","ir-window-length","ir-calibration","prepare","wet","solo"])$(id).disabled=busy;
  for(const b of document.querySelectorAll("[data-mode]")){b.disabled=busy||!session;b.setAttribute("aria-pressed",String(b.dataset.mode===appliedMode));}
  for(const id of ["play","pause","stop","seek","apply-mix"])$(id).disabled=busy||!session;
  $("ir-live").hidden=appliedMode!=="ir-window";
  $("ir-window-scrub").disabled=(busy&&!windowApplying)||!session||appliedMode!=="ir-window";
  if(windowApplying)for(const id of ["ir-window-start","ir-window-length","ir-calibration"])$(id).disabled=false;
  $("scrub-axes").hidden=!isScrubMode(appliedMode);
  for(const name of ["source","wet"])for(const suffix of ["seek","speed","repeat","range-start","range-end"])
    $(name+"-"+suffix).disabled=busy||!session||!isScrubMode(appliedMode);
}
function show(frame){
  if(!session)return;
  if(!seeking)seek.value=String(Math.min(session.length,Math.max(0,Math.round(frame))));
  $("time").textContent=((session.interval.start+frame)/session.sampleRate).toFixed(3)+" s";
}
async function run(fn){
  if(busy)return;busy=true;controls();
  try{await fn();}catch(e){message("処理できません: "+e.message);}
  finally{busy=false;controls();pumpWindow();}
}
async function audio(){
  if(!ctx){ctx=new AudioContext();player=createPreviewPlayer(ctx,{onState:s=>{
    if(s.error){message("再生エラー: "+s.error);return;}
    show(s.position);showAxes(s.axes);
    if(s.event?.type==="render-applied"&&s.event.missingFramesInBlock===0)
      status.dataset.renderApplied=String(s.event.requestId);
    if(s.event?.type==="progress")status.dataset.renderedFrames=String(s.event.renderedFrames);
  }});}
  await ctx.resume();
}
const binding=createWetMixBinding();
mountWetMixField({field:$("wet"),binding,onChanged:()=>{message("Wet設定変更・未反映。Wet設定を反映、または方式を切り替えてください。");}});
async function loadMode(target,next,options={}){
  if(isScrubMode(next)){
    const positions=options.reset?{}:{...savedAxes,
      source:{...savedAxes.source,frame:Math.round(player.state.position)}};
    await player.load(target.signals.dry,target.gain.applied,{...options,
      scrub:{wet:target.signals.normal,mode:next,mix:binding.value,solo:$("solo").value},positions});
  }else await player.load(target.select(next,binding.value,$("solo").value),target.gain.applied,options);
}
async function choose(next){
  if(!session)return;
  if(next!==mode)cancelWindowRequests();
  await audio();
  if(next!==mode||!isScrubMode(next)||!player.setMix(binding.value,$("solo").value))await loadMode(session,next);
  if(isScrubMode(next))showAxes(player.state.axes);
  mode=appliedMode=next;
  message("適用: "+mode+" / Wet "+(binding.value*100).toFixed(3)+"%");
  show(player.state.position);
}
$("prepare").onclick=()=>run(async()=>{
  cancelWindowRequests();
  if(windowWork)await windowWork;
  message("比較音を計算中…");await audio();
  const source=$("source").value==="file"?sourceFile:makeSource($("source").value,{frequency:Number($("frequency").value)});
  const ir=$("ir").value==="file"?irFile:makeIR($("ir").value,{seconds:Number($("ir-length").value)});
  if(!source||!ir)throw Error("素材を選択してください");
  const next=await prepareComparison(source,ir,{predelay:readNumber("predelay")/1000,irWindow:readWindow()});
  await loadMode(next,mode,{frame:0,resume:false,reset:true});
  session=next;savedAxes={};seek.max=String(next.length);show(0);
  for(const name of ["source","wet"]){
    $(name+"-seek").max=String(next.length-1);$(name+"-speed").value="1";$(name+"-repeat").checked=false;
    const a=next.interval.start/next.sampleRate,b=(next.interval.start+next.length)/next.sampleRate;
    for(const suffix of ["range-start","range-end"]){
      $(name+"-"+suffix).min=String(a);$(name+"-"+suffix).max=String(b);
    }
    $(name+"-range-start").value=String(a);$(name+"-range-end").value=String(b);
  }
  showAxes(player.state.axes);
  showWindow(next);
  message("準備済み: "+mode);status.dataset.prepared="true";
});
for(const [id,select,set] of [["source-file","source",v=>sourceFile=v],["ir-file","ir",v=>irFile=v]]){
  $(id).onchange=()=>run(async()=>{
    const file=$(id).files?.[0];if(!file)return;
    try{const data=await readLocalWav(file);set(data);const opt=$(select).querySelector('[value="file"]');opt.disabled=false;$(select).value="file";message(file.name+" 読込済み。比較音を準備してください。");}
    finally{$(id).value="";}
  });
}
for(const button of document.querySelectorAll("[data-mode]"))button.onclick=()=>run(()=>choose(button.dataset.mode));
$("solo").onchange=()=>run(()=>choose(mode));
$("apply-mix").onclick=()=>run(()=>choose(mode));
$("play").onclick=()=>run(async()=>{await audio();if(!isScrubMode(mode)&&player.state.position>=session.length)await player.seek(0);await player.play();message("再生要求を受理");});
$("pause").onclick=()=>run(async()=>{await player.pause();message("一時停止");});
$("stop").onclick=()=>run(async()=>{await player.pause();await player.seek(0);show(0);message("先頭");});
seek.addEventListener("input",()=>{seeking=true;show(Number(seek.value));});
seek.addEventListener("change",()=>{const frame=Number(seek.value);seeking=false;void run(()=>player.seek(frame));});
for(const name of ["source","wet"]){
  const slider=$(name+"-seek"),speed=$(name+"-speed"),repeat=$(name+"-repeat");
  slider.oninput=()=>{dragging.add(name);$(name+"-position").textContent=((session.interval.start+Number(slider.value))/session.sampleRate).toFixed(3)+" s（要求）";};
  slider.onchange=()=>{const frame=Number(slider.value);dragging.delete(name);void run(async()=>{await player.configureAxis(name,{frame});showAxes(player.state.axes);});};
  speed.onchange=()=>run(async()=>{if(!speed.value.trim())throw Error("速度を入力してください");await player.configureAxis(name,{speed:Number(speed.value)});showAxes(player.state.axes);});
  const applyRange=()=>run(async()=>{
    const toFrame=id=>secondsToFrames(readNumber(id),session.sampleRate)-session.interval.start;
    await player.configureAxis(name,{repeat:repeat.checked,
      rangeStartFrame:toFrame(name+"-range-start"),rangeEndFrame:toFrame(name+"-range-end")});
    showAxes(player.state.axes);message(name+" の反復区間を適用");
  });
  // Disabling repeat must not depend on the validity of the edited draft.
  repeat.onchange=()=>repeat.checked?applyRange():run(async()=>{
    await player.configureAxis(name,{repeat:false});
    showAxes(player.state.axes);message(name+" の反復を解除");
  });
  $(name+"-range-start").onchange=applyRange;$(name+"-range-end").onchange=applyRange;
}
$("ir-window-scrub").oninput=()=>{$("ir-window-start").value=$("ir-window-scrub").value;requestWindow();};
for(const id of ["ir-window-start","ir-window-length","ir-calibration"])$(id).onchange=requestWindow;
window.addEventListener("pagehide",()=>{cancelWindowRequests();player?.dispose();void ctx?.close();},{once:true});
controls();
