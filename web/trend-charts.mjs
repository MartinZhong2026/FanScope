// Chart options share the same observed counts on desktop and mobile.
import {matrixSeries,annualMatrixSeries,matrixDistribution} from './research-visuals.mjs';
export const chartColors=['#87dbe8','#b9a1eb','#e4a2cf','#8bd9c3','#f1c190','#cadb9d','#8ea5d6'];
export const designName=v=>({cross_sectional:'横截面研究',repeated_cross_sectional:'重复横截面',panel_longitudinal:'纵向 / 面板研究',longitudinal_panel:'纵向 / 面板研究',cohort:'队列研究',experimental:'实验研究',experiment:'实验研究',quasi_experimental:'准实验研究',qualitative:'质性研究',mixed_methods:'混合方法',review:'综述',other:'其他设计',unknown:'未知设计'})[v]||'未分类设计';
export const methodName=v=>({DID:'双重差分',SEM:'结构方程模型',fixed_effects:'固定效应',multilevel:'多层模型',regression:'回归分析',survival:'生存分析',thematic_analysis:'主题分析',other:'其他方法'})[v]||'未分类方法';
export const sourceName=v=>({first_party_team_collection:'一手调查数据',secondary_public:'公开二手数据',secondary_restricted:'受限二手数据',administrative:'行政数据',mixed:'混合来源',unknown:'未知来源',undated_known:'已知来源 / 日期未知'})[v]||'未分类来源';
export const unitName=v=>({person:'人',household:'家庭',institution:'机构',observation:'观察记录',interview:'访谈',other:'其他单位'})[v]||'单位未知';
export const distributionRows=(totals,matrix)=>totals?Object.entries(totals).map(([name,n])=>({name,n})).filter(x=>x.n>0).sort((a,b)=>b.n-a.n||a.name.localeCompare(b.name)):matrixDistribution(matrix);
export function wrapLabel(value,width=14){
 const text=String(value);if(!text.includes(' '))return text.match(new RegExp(`.{1,${width}}`,'gu'))?.join('\n')||'';
 const lines=[];let line='';for(const word of text.split(/\s+/)){if(line&&line.length+1+word.length>width){lines.push(line);line='';}line+=(line?' ':'')+word;}if(line)lines.push(line);return lines.join('\n');
}
export function barOption(rows,label){
 return {tooltip:{trigger:'item',confine:true},grid:{left:4,right:40,top:8,bottom:24,containLabel:true},
  xAxis:{type:'value',minInterval:1},yAxis:{type:'category',inverse:true,data:rows.map(x=>label(x.name)),axisTick:{show:false},axisLabel:{interval:0,formatter:v=>wrapLabel(v)}},
  series:[{type:'bar',barMaxWidth:22,label:{show:true,position:'right'},data:rows.map((x,i)=>({name:label(x.name),value:x.n,itemStyle:{color:chartColors[i%chartColors.length],borderRadius:[0,4,4,0]}}))}]};
}
export function distributionOption(rows,label,validN){
 const positive=rows.filter(x=>x.n>0);
 if(validN<30||positive.length<3)return {...barOption(positive,label),displayMode:'bar'};
 return {displayMode:'donut',tooltip:{trigger:'item',confine:true},series:[{type:'pie',radius:['48%','76%'],center:['50%','50%'],label:{show:false},emphasis:{scale:false},data:positive.map((x,i)=>({name:label(x.name),value:x.n,itemStyle:{color:chartColors[i%chartColors.length]}}))}]};
}
export function temporalOption(matrix,monthly,label,validN,{annual=false}={}){
 const data=annual?annualMatrixSeries(matrix):matrixSeries(matrix,monthly),rows=matrixDistribution(matrix),active=data.months.filter((m,i)=>data.series.some(s=>s.values[i]>0)).length;
 if(validN<30||active<3){
  const o=barOption(rows,label);o.displayMode='bar';
  // Separate series retain category identity for click-through and legend colors.
  o.series=rows.map((row,i)=>({name:label(row.name),type:'bar',stack:'observed',barMaxWidth:22,itemStyle:{color:chartColors[i%chartColors.length]},label:{show:true,position:'right'},data:rows.map((r,j)=>i===j?r.n:null)}));
  return o;
 }
 return {displayMode:'line',tooltip:{trigger:'axis',confine:true},grid:{left:4,right:12,top:16,bottom:28,containLabel:true},xAxis:{type:'category',boundaryGap:false,data:data.months,axisLabel:{hideOverlap:true}},yAxis:{type:'value',minInterval:1},series:data.series.map(s=>({name:label(s.name),type:'line',symbol:'circle',symbolSize:5,lineStyle:{width:2},itemStyle:{color:chartColors[rows.findIndex(x=>x.name===s.name)%chartColors.length]},data:s.values}))};
}
