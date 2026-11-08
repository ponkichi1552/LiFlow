import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const platform of ['ios', 'android']) test(`${platform} a long chore rail scrolls its own window at an edge and stops after the gesture ends`, async t => {
 const chosen=[];const active=[];
 const s=screenHarness('src/components/chore-category-rail.tsx',{exportName:'ChoreCategoryRail',platform,layoutEffect:fn=>fn(),
  props:{groups:[{name:'家事',chores:Array.from({length:40},(_,i)=>({id:`c${i}`,name:`家事${i}`}))}],category:'家事',selectedId:'c0',onSelect:id=>chosen.push(id),onScrubChange:value=>active.push(value)}});
 const root=s.nodes().find(n=>n.props.onPanResponderGrant);
 t.after(()=>{root.props.onPanResponderRelease();s.unmount();});
 root.props.ref({measureInWindow:fn=>fn(0,100,40,112)});
 root.props.onLayout({nativeEvent:{layout:{height:112}}});s.render();
 assert.ok(s.nodes().filter(n=>n.props.accessibilityRole==='button').length<40);
 root.props.onPanResponderGrant({nativeEvent:{pageY:207}},{moveY:207});
 const first=Number(chosen.at(-1).slice(1));await new Promise(resolve=>setTimeout(resolve,520));s.render();
 assert.ok(Number(chosen.at(-1).slice(1))>first,'holding the bottom edge must reach chores outside the first visible window');
 root.props.onPanResponderRelease();const ended=chosen.length;await new Promise(resolve=>setTimeout(resolve,330));
 assert.equal(chosen.length,ended);assert.deepEqual(active,[true,false]);
 root.props.onAccessibilityAction({nativeEvent:{actionName:'increment'}});const next=Number(chosen.at(-1).slice(1));
 root.props.onAccessibilityAction({nativeEvent:{actionName:'decrement'}});assert.equal(Number(chosen.at(-1).slice(1)),next-1);
});
