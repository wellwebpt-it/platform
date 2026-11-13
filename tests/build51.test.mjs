import assert from 'node:assert/strict';
import { canCancelBooking, groupBookingTotal } from '../src/lib/build51.js';
let count = 0;
function check(name, run) { run(); count++; console.log(`PASS ${name}`); }
check('per-student group pricing uses integer cents', () => assert.equal(groupBookingTotal({price:15,allowsGroup:true,pricePerStudent:true,students:6}),90));
check('fixed group pricing remains a single service price', () => assert.equal(groupBookingTotal({price:120,allowsGroup:true,pricePerStudent:false,students:5}),120));
check('individual booking total stays unchanged', () => assert.equal(groupBookingTotal({price:40,allowsGroup:false,pricePerStudent:false,students:1}),40));
check('group price avoids binary floating point residue', () => assert.equal(groupBookingTotal({price:0.1,allowsGroup:true,pricePerStudent:true,students:3}),0.3));
check('professional can cancel at exactly 24 hours', () => {const start=Date.parse('2026-12-20T15:00:00Z');assert.equal(canCancelBooking({role:'PROFESSIONAL',status:'CONFIRMED',startsAt:start,now:start-24*3600*1000}),true)});
check('professional cannot cancel after the 24-hour cutoff', () => {const start=Date.parse('2026-12-20T15:00:00Z');assert.equal(canCancelBooking({role:'PROFESSIONAL',status:'CONFIRMED',startsAt:start,now:start-24*3600*1000+1}),false)});
check('professional cannot cancel a pending request', () => assert.equal(canCancelBooking({role:'PROFESSIONAL',status:'PENDING',startsAt:Date.now()+72*3600*1000}),false));
check('hotel can cancel at exactly 12 hours', () => {const start=Date.parse('2026-12-20T15:00:00Z');assert.equal(canCancelBooking({role:'HOTEL',status:'PENDING',startsAt:start,now:start-12*3600*1000}),true)});
check('hotel cannot cancel after the 12-hour cutoff', () => {const start=Date.parse('2026-12-20T15:00:00Z');assert.equal(canCancelBooking({role:'HOTEL',status:'CONFIRMED',startsAt:start,now:start-12*3600*1000+1}),false)});
console.log(`${count} Build 5.1 utility checks passed.`);
