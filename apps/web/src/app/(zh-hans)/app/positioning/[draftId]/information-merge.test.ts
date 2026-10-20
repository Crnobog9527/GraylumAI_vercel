import { describe, expect, it } from "vitest";
import { mergeInformation } from "./information-merge";
const v = (value: string) => ({value, status:"provisional",nature:"user_input"});
describe("information three-way merge",()=>{
  it("retains required empty schema entries without treating them as edits",()=>{
    const empty={value:"",status:"unknown",nature:"unknown"};
    expect(mergeInformation({}, {a:v("A"),b:empty},{})).toEqual({values:{a:v("A"),b:empty},conflicts:[]});
  });
  it("keeps another tab's field when a stale full buffer uses a fresh read",()=>{
    expect(mergeInformation({a:v("old"),b:v("old")},{a:v("old"),b:v("B")},{a:v("A"),b:v("old")})).toEqual({values:{a:v("A"),b:v("B")},conflicts:[]});
  });
  it("retains same-field disagreement instead of choosing either writer",()=>{
    expect(mergeInformation({a:v("old")},{a:v("B")},{a:v("A")})).toEqual({values:{a:v("A")},conflicts:["a"]});
  });
  it("recognizes an already committed edit without a new conflict",()=>{
    expect(mergeInformation({a:v("old")},{a:v("B")},{a:v("B")})).toEqual({values:{a:v("B")},conflicts:[]});
  });
});
