import test from "node:test";
import assert from "node:assert/strict";
import {pcmRMS,rmsCorrection,createLocalRMSCalibration} from "../src/level-calibration.mjs";
test("common RMS calibration preserves interchannel relationship and bounds",()=>{
  const l=Float32Array.of(1,1,.1,.1),r=l.map(x=>-x);
  assert.ok(Math.abs(pcmRMS([l,r])-Math.sqrt(.505))<1e-7);
  const c=createLocalRMSCalibration([l,r],2);
  assert.equal(c.scaleAt(3,"natural"),1);
  assert.ok(Math.abs(c.scaleAt(3,"compensated")-Math.sqrt(.505)/.1)<1e-6);
  assert.ok(Math.abs(c.scaleAt(0,"compensated")-Math.sqrt(.505))<1e-7);
  assert.equal(rmsCorrection(1,0),1);assert.equal(rmsCorrection(1,1e-10),8);
  assert.equal(createLocalRMSCalibration([Float32Array.of(0,0)],1).scaleAt(0,"compensated"),1);
  assert.throws(()=>c.scaleAt(0,"invalid"),/不正/);assert.throws(()=>c.scaleAt(NaN),/不正/);
  assert.throws(()=>pcmRMS([l],2,2),/不正/);
});
