// Report verification is fully offline: no DOM, browser, network or live records.
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
const project=new URL('../',import.meta.url);
registerHooks({resolve(specifier,context,next){
 if(specifier.startsWith('.')&&context.parentURL?.startsWith(project.href)&&!specifier.endsWith('.ts')&&!specifier.endsWith('.mjs'))return {url:new URL(specifier+'.ts',context.parentURL).href,shortCircuit:true};
 return next(specifier,context);
}});
globalThis.fetch=()=>{throw new Error('Report tests must not use the network');};
const {reportHtml}=await import('../app/lib/report.ts');
const image='data:image/png;base64,AA==';
const base={id:'record-1',revision:2,partId:'test-part',batchId:'batch-1',filename:'detection.png',createdAt:'2026-10-30T12:23:35Z',width:960,height:540,imageUrl:image,resultImageUrl:image,imageRole:'paired-display',source:'fpga',captureMetadata:{captureKind:'paired-display',scratchCount:7},boxes:[],quality:{measured:false,brightness:0,darkRatio:0,brightRatio:0,sharpness:0,warnings:[],verdict:'review'},review:{label:'pending',note:''},ai:null};
const box={id:'one',x:.1,y:.2,w:.1,h:.1,label:'scratch',note:'保留划痕',origin:'fpga'};

test('removed regions are excluded from current report counts and crops, retaining an audit trail',()=>{
 const html=reportHtml({...base,boxes:[box,{...box,id:'removed',removed:true,note:'背景木纹'},{...box,id:'pending',label:'pending',note:''}]},image,[image,null]);
 assert.match(html,/当前区域 2 个 · 已确认划痕 1 个 · 待复核 1 个 · 已移除 1 个/);
 assert.match(html,/设备原始上报候选 7 处/);assert.match(html,/人工复核预览，框线处作显示处理；原始检测截图另保留/);
 assert.match(html,/已移除区域/);assert.match(html,/区域 removed · 移除前标签：确认划痕 · 背景木纹/);
 assert.equal((html.match(/<article class="crop-card">/g)||[]).length,2);
 assert.doesNotMatch(html,/平均亮度 \/ 255/);assert.doesNotMatch(html,/设备结果图（按原文件保存）/);
});

test('all removed regions produce zero current defects and escape audit notes',()=>{
 const html=reportHtml({...base,boxes:[{...box,removed:true,note:'<script>bad</script>'}]},image,[]);
 assert.match(html,/当前区域 0 个 · 已确认划痕 0 个 · 待复核 0 个 · 已移除 1 个/);
 assert.match(html,/尚无区域标注/);assert.match(html,/&lt;script&gt;bad&lt;\/script&gt;/);assert.doesNotMatch(html,/<script>/);
 assert.equal((html.match(/<article class="crop-card">/g)||[]).length,0);
});
