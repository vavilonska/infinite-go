import test from 'node:test';
import assert from 'node:assert/strict';
import {createTree} from '../tree.js';
import {createGame} from '../engine.js';
class Element {
 constructor(tag){this.tag=tag;this.attrs={};this.children=[];this.listeners={};this.clientWidth=600;this.clientHeight=400;this.classList={contains:c=>(this.attrs.class||'').split(' ').includes(c)};}
 setAttribute(k,v){this.attrs[k]=v;}
 append(...nodes){this.children.push(...nodes);}
 replaceChildren(){this.children=[];}
 addEventListener(type,fn){this.listeners[type]=fn;}
 getBoundingClientRect(){return {left:0,top:0};}
 setPointerCapture(){}
 fire(type,extra={}){this.listeners[type]?.({type,target:this,pointerId:1,clientX:0,clientY:0,preventDefault(){},stopPropagation(){},...extra});}
}
test('tree tap selects current leaf, cumulative drag does not select, Space selects',()=>{
 const previous=globalThis.document;globalThis.document={createElementNS:(_,tag)=>new Element(tag)};
 try{
  const container=new Element('div'),selected=[];
  const tree=createTree(container,(...args)=>selected.push(args));tree.render(createGame());
  const svg=container.children[0],node=svg.children[0].children.find(n=>n.attrs.role==='button');
  svg.fire('pointerdown',{target:node});svg.fire('pointerup',{target:node});node.fire('click');
  assert.deepEqual(selected,[[1,0]]);
  svg.fire('pointerdown',{target:node});for(let x=1;x<=8;x++)svg.fire('pointermove',{target:node,clientX:x});svg.fire('pointerup',{target:node,clientX:8});node.fire('click');
  assert.equal(selected.length,1);
  node.fire('keydown',{key:' '});assert.equal(selected.length,2);
  svg.fire('pointerdown',{target:node});svg.fire('pointerup',{target:node});node.fire('click');assert.equal(selected.length,3);
 }finally{globalThis.document=previous;}
});
