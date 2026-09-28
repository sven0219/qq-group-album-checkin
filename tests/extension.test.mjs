import fs from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWorkbook} from '../extension/xlsx.js';

const code=(await fs.readFile(new URL('../extension/background.js',import.meta.url),'utf8')).replace('import { makeWorkbook } from "./xlsx.js";','');
function environment() {
  let handler, saved={}, operation;
  const tab={id:1,status:'complete',url:'https://h5.qzone.qq.com/groupphoto/index?groupId=123456789'};
  const events=[];
  const context=vm.createContext({makeWorkbook,URL,Date,btoa,setTimeout,chrome:{
    runtime:{onMessage:{addListener:fn=>{handler=fn;}},sendMessage:async message=>{operation=message.operation;}},
    storage:{local:{get:async()=>saved,set:async value=>{Object.assign(saved,value);}}},
    tabs:{query:async()=>[tab],get:async()=>tab,reload:async()=>events.push('refresh'),sendMessage:async(_id,message)=>{events.push(message.type);return message.type==='PING'?{version:2}:{ok:true,complete:true,albums:[]};}},
    downloads:{download:async options=>{events.push('download');assert.ok(options.filename.includes('演示班'));return 1;}}
  }});
  vm.runInContext(code,context);
  return {run:script=>vm.runInContext(script,context),rpc:message=>new Promise(resolve=>handler(message,{},resolve)),events,get operation(){return operation;}};
}
const config={term:'演示学期',className:'演示班',groupId:'123456789',semesterStartDate:'2026-09-01',roster:[{studentNo:1,name:'示例小朋友甲',albumName:'示例小朋友甲'}]};
test('shared defaults contain no group or roster',async()=>{
  const e=environment(),reply=await e.rpc({type:'GET_STATE'});
  assert.equal(reply.data.groupId,'');assert.equal(reply.data.roster.length,0);assert.equal(reply.data.semesterStartDate,'');
});
test('configurable semester weeks and valid calendar range',()=>{
  const e=environment();
  assert.equal(e.run('weekNumber({...initial,semesterStartDate:"2027-02-22"},"2027-03-01")'),2);
  assert.equal(e.run('dateRange({...initial,semesterStartDate:"2027-02-22"},"2027-02-24","2027-03-03").to'),2);
  assert.throws(()=>e.run('validateDate("2027-02-30")'));
  assert.throws(()=>e.run('dateRange({...initial,semesterStartDate:"2027-02-22"},"2027-03-03","2027-02-24")'));
});
test('week exports include dates and freeze rows only',()=>{
  const e=environment(),result=e.run(`exportOneWeek({...initial,...${JSON.stringify(config)}},"2026-09-22")`);
  assert.equal(result.weekName,'第4周');assert.equal(result.dateRange,'2026-09-21 至 2026-09-27');
  const xml=new TextDecoder().decode(result.bytes);
  assert.ok(!xml.includes('xSplit='));assert.ok(xml.includes('ySplit="6" topLeftCell="A7"'));
  assert.ok(xml.includes('历史明细'));assert.ok(xml.includes('统计说明'));assert.ok(xml.includes('演示班'));
});
test('export refreshes, scans then downloads and reports dates',async()=>{
  const e=environment();assert.equal((await e.rpc({type:'SAVE_SETTINGS',data:config})).ok,true);
  const reply=await e.rpc({type:'EXPORT_SELECTED_WEEK',weekStart:'2026-09-22'});
  assert.equal(reply.ok,true);assert.equal(reply.dateRange,'2026-09-21 至 2026-09-27');
  assert.ok(e.events.indexOf('refresh')<e.events.indexOf('READ_ALBUMS'));
  assert.ok(e.events.indexOf('READ_ALBUMS')<e.events.indexOf('download'));
  assert.ok(e.operation.text.includes('第4周（2026-09-21 至 2026-09-27）'));
});
