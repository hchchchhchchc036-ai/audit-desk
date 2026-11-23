import {Document,Footer,HeadingLevel,PageNumber,Packer,Paragraph,Table,TableCell,TableRow,TextRun,WidthType,AlignmentType} from 'docx';
import type {TaskRecord} from './contracts';
import {buildChineseReport,reportTitle} from './report-content';

export async function createWordReport(task:TaskRecord):Promise<Buffer>{
  const paragraph=(value:string,code=false)=>new Paragraph({spacing:{after:120,line:300},children:[new TextRun({text:value,font:code?'Consolas':'Microsoft YaHei',size:code?18:22})]});
  const children:(Paragraph|Table)[]=[new Paragraph({text:reportTitle(task),heading:HeadingLevel.TITLE}),paragraph('Audit Desk · 中文审计与测试报告'),paragraph(`报告生成时间：${new Date().toLocaleString('zh-CN')}`)];
  for(const section of buildChineseReport(task)){
    children.push(new Paragraph({text:section.title,heading:HeadingLevel.HEADING_1,keepNext:true}));
    for(const line of section.lines||[])children.push(...line.split('\n').map(value=>paragraph(value)));
    if(section.table){
      const row=(values:string[],head=false)=>new TableRow({tableHeader:head,children:values.map(value=>new TableCell({shading:head?{fill:'E7EFEA'}:undefined,children:[new Paragraph({children:[new TextRun({text:value,font:'Microsoft YaHei',size:20,bold:head})]})]}))});
      children.push(new Table({width:{size:100,type:WidthType.PERCENTAGE},rows:[row(section.table.headers,true),...section.table.rows.map(values=>row(values))]}));
      children.push(paragraph(''));
    }
    if(section.code)children.push(...section.code.split('\n').map(line=>paragraph(line,true)));
  }
  const doc=new Document({creator:'Audit Desk',title:reportTitle(task),description:'中文代码审计与软件测试报告',styles:{default:{document:{run:{font:'Microsoft YaHei',size:22,color:'17241A'},paragraph:{spacing:{after:120,line:300}}},heading1:{run:{font:'Microsoft YaHei',size:28,bold:true,color:'245536'},paragraph:{spacing:{before:260,after:140}}},title:{run:{font:'Microsoft YaHei',size:40,bold:true,color:'183B27'}}}},sections:[{properties:{page:{size:{width:11906,height:16838},margin:{top:1200,right:1100,bottom:1200,left:1100}}},footers:{default:new Footer({children:[new Paragraph({alignment:AlignmentType.CENTER,children:[new TextRun({text:'Audit Desk · 第 ',size:18}),new TextRun({children:[PageNumber.CURRENT],size:18}),new TextRun({text:' 页',size:18})]})]})},children}]});
  return Packer.toBuffer(doc);
}
