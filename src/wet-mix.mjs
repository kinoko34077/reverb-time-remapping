import {defineParameter,createParameterBinding} from "../shared/fw/parameter-binding.mjs";
import {mountPercentParameterField} from "../shared/fw/frequency-unit-field.mjs";

// Wet fraction is semantically the same parameter as FW wet. The common
// binding owns precision and input lifecycle; this adapter owns only RTR mix.
export function createWetMixBinding({initialValue=0.5,onChange=()=>{}}={}){
  const descriptor=defineParameter({id:"wet",min:0,max:1,defaultValue:0.5,
    units:["percent"],rail:{toPosition:x=>x,fromPosition:x=>x}});
  return createParameterBinding(descriptor,{initialValue,onChange});
}
export function mountWetMixField({field,binding,onChanged}){
  const refresh=()=>{field.value=String(binding.display(3));};
  refresh();
  return mountPercentParameterField({field,binding,refresh,onChanged});
}
