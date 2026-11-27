import {defineParameter,createParameterBinding} from "../shared/fw/parameter-binding.mjs";
import {mountCanonicalTypedField} from "../shared/fw/frequency-unit-field.mjs";
import {parseView} from "../shared/fw/parameter-units.mjs";

// Wet fraction is semantically the same parameter as FW wet. The common
// binding owns precision and input lifecycle; this adapter owns only RTR mix.
export function createWetMixBinding({initialValue=0.5,onChange=()=>{}}={}){
  const descriptor=defineParameter({id:"wet",min:0,max:1,defaultValue:0.5,
    units:["percent"],rail:{toPosition:x=>x,fromPosition:x=>x}});
  return createParameterBinding(descriptor,{initialValue,onChange});
}
export function mountWetMixField({field,binding,onChanged}){
  const displayValue=()=>String(binding.display(3));
  const focusValue=()=>String(binding.value*100);
  field.value=displayValue();
  return mountCanonicalTypedField({field,binding,displayValue,focusValue,
    parseCanonical:raw=>{
      if(!String(raw).trim())return null;
      if(String(raw)===focusValue())return binding.value;
      return parseView(raw,"percent",{id:binding.descriptor.id,
        fromRail:binding.descriptor.rail.fromPosition});
    },
    onValueChange:onChanged});
}
