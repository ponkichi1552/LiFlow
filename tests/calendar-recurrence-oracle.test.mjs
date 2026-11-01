import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';

test('independent daily enumeration agrees with 4096 seeded custom and preset recurrence windows', () => {
const iso=n=>new Date(n).toISOString().slice(0,10), at=d=>Date.parse(d+'T00:00:00Z'), day=86400000;
let seed=0x11ca1; const random=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n};
function matches(e,date){
 const b=new Date(at(e.startDate)),d=new Date(at(date)),elapsed=(at(date)-at(e.startDate))/day;
 if(elapsed<0||e.untilDate&&date>e.untilDate)return false;
 const r=e.recurrence==='custom'?e.customRecurrence:{unit:({none:'once',daily:'day',weekly:'week',biweekly:'week',monthly:'month',yearly:'year'})[e.recurrence],interval:e.recurrence==='biweekly'?2:1};
 if(r.unit==='once')return elapsed===0;
 if(r.unit==='day')return elapsed%r.interval===0;
 if(r.unit==='week'){if(e.recurrence!=='custom')return elapsed%(7*r.interval)===0;const baseSunday=at(e.startDate)-b.getUTCDay()*day;return Math.floor((at(date)-baseSunday)/day/7)%r.interval===0&&r.weekdays.includes(d.getUTCDay())}
 const months=(d.getUTCFullYear()-b.getUTCFullYear())*12+d.getUTCMonth()-b.getUTCMonth();
 if(r.unit==='year')return months%(r.interval*12)===0&&d.getUTCDate()===b.getUTCDate();
 if(months%r.interval!==0)return false;
 if(r.on!=='weekday')return d.getUTCDate()===b.getUTCDate();
 const next=new Date(at(date)+7*day);return d.getUTCDay()===r.weekday&&(r.ordinal===-1?next.getUTCMonth()!==d.getUTCMonth():Math.ceil(d.getUTCDate()/7)===r.ordinal);
}
let checked=0;

for(let i=0;i<4096;i++){
 const start=iso(Date.UTC(2018+random(10),random(12),1+random(28))),span=random(5);
 const recurrence=['none','daily','weekly','biweekly','monthly','yearly','custom'][random(7)];
 const unit=['day','week','month','year'][random(4)];
 const customRecurrence=unit==='week'?{unit,interval:1+random(4),weekdays:[...new Set([random(7),random(7),random(7)])]}:unit==='month'?random(2)?{unit,interval:1+random(5),on:'weekday',weekday:random(7),ordinal:[-1,1,2,3,4,5][random(6)]}:{unit,interval:1+random(5),on:'date'}:{unit,interval:1+random(4)};
 const e={...newEventDraft(start,'UTC'),title:'Synthetic oracle',allDay:true,endDate:iso(at(start)+span*day),recurrence,customRecurrence,id:'audit',revision:1,untilDate:random(2)?iso(at(start)+(10+random(500))*day):null};
 const from=iso(at(start)+random(1000)*day),through=iso(at(from)+(1+random(90))*day),expected=[];
 for(let t=at(from)-span*day;t<=at(through);t+=day){const d=iso(t);if(matches(e,d))expected.push(d)}
 const actual=projectCalendarEvents([e],[],from,through).map(row=>row.anchorDate);
 assert.deepEqual(actual,expected,JSON.stringify({e,from,through}));checked++;
}
assert.equal(checked, 4096);
});
