import {makeSource,makeIR,readLocalWav} from "../src/materials.mjs";
import {prepareComparison} from "../src/comparison-session.mjs";
import {createPreviewPlayer} from "../src/preview-player.mjs";
import {createWetMixBinding,mountWetMixField} from "../src/wet-mix.mjs";
const $=id=>document.getElementById(id);
let ctx,player,session,mode="dry",appliedMode="dry",busy=false,seeking=false,sourceFile=null,irFile=null;
const status=$("status"),seek=$("seek");
function message(s){status.textContent=s;}
function controls(){
  for(const id of ["source","source-file","ir","ir-file","frequency","ir-length","predelay","prepare","wet","solo"])$(id).disabled=busy;
  for(const b of document.querySelectorAll("[data-mode]")){b.disabled=busy||!session;b.setAttribute("aria-pressed",String(b.dataset.mode===appliedMode));}
  for(const id of ["play","pause","stop","seek"])$(id).disabled=busy||!session;
}
function show(frame){
  if(!session)return;
  if(!seeking)seek.value=String(Math.min(session.length,Math.max(0,Math.round(frame))));
  $("time").textContent=((session.interval.start+frame)/session.sampleRate).toFixed(3)+" s";
}
async function run(fn){
  if(busy)return;busy=true;controls();
  try{await fn();}catch(e){message("処理できません: "+e.message);}
  finally{busy=false;controls();}
}
async function audio(){
  if(!ctx){ctx=new AudioContext();player=createPreviewPlayer(ctx,{onState:s=>{
    if(s.error){message("再生エラー: "+s.error);return;}
    show(s.position);
    if(s.event?.type==="render-applied"&&s.event.missingFramesInBlock===0)
      status.dataset.renderApplied=String(s.event.requestId);
    if(s.event?.type==="progress")status.dataset.renderedFrames=String(s.event.renderedFrames);
  }});}
  await ctx.resume();
}
const binding=createWetMixBinding();
mountWetMixField({field:$("wet"),binding,onChanged:()=>{message("Wet設定変更。方式を再選択すると反映します。");}});
async function choose(next){
  if(!session)return;
  await audio();
  await player.load(session.select(next,binding.value,$("solo").value),session.gain.applied);
  mode=appliedMode=next;
  message("適用: "+mode+" / Wet "+(binding.value*100).toFixed(3)+"%");
  show(player.state.position);
}
$("prepare").onclick=()=>run(async()=>{
  message("比較音を計算中…");await audio();
  const source=$("source").value==="file"?sourceFile:makeSource($("source").value,{frequency:Number($("frequency").value)});
  const ir=$("ir").value==="file"?irFile:makeIR($("ir").value,{seconds:Number($("ir-length").value)});
  if(!source||!ir)throw Error("素材を選択してください");
  const next=await prepareComparison(source,ir,{predelay:Number($("predelay").value)/1000});
  await player.load(next.select(mode,binding.value,$("solo").value),next.gain.applied,{frame:0,resume:false});
  session=next;seek.max=String(next.length);show(0);
  $("gain").textContent="共通出力ゲイン "+next.gain.applied.toFixed(4)+"（安全減衰を含む）";
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
$("play").onclick=()=>run(async()=>{await audio();if(player.state.position>=session.length)await player.seek(0);await player.play();message("再生要求を適用");});
$("pause").onclick=()=>run(async()=>{await player.pause();message("一時停止");});
$("stop").onclick=()=>run(async()=>{await player.pause();await player.seek(0);show(0);message("先頭");});
seek.addEventListener("input",()=>{seeking=true;show(Number(seek.value));});
seek.addEventListener("change",()=>{const frame=Number(seek.value);seeking=false;void run(()=>player.seek(frame));});
window.addEventListener("pagehide",()=>{player?.dispose();void ctx?.close();},{once:true});
controls();
