// Tes inti teori MGCHORD: node tools/mgchord-test.ts
import { chordAt, voice, defaultVoicing, buildNotes, PRESETS, slotsOf, randomProgression, toMidi, totalBeats, VOICES, type Settings } from '../src/mgchord-theory.ts';
let fail = 0;
const eq = (name: string, a: unknown, b: unknown) => { const ok = JSON.stringify(a) === JSON.stringify(b); if (!ok) fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' -> ' + JSON.stringify(a) + ' != ' + JSON.stringify(b))); };
const S = (o: Partial<Settings> = {}): Settings => ({ root: 0, scale: 'Major', octave: 0, chordType: 'Diatonic', ...o });

eq('C major I', chordAt(S(), 0).name, 'C');
eq('C major ii', chordAt(S(), 1).name, 'Dm');
eq('C major vii', chordAt(S(), 6).name, 'Bdim');
eq('C major V 7th', chordAt(S({ chordType: 'Diatonic 7th' }), 4).name, 'G7');
eq('C major I 7th', chordAt(S({ chordType: 'Diatonic 7th' }), 0).name, 'Cmaj7');
eq('C minor i 9th', chordAt(S({ scale: 'Minor', chordType: 'Diatonic 9th' }), 0).name, 'Cm9');
eq('C minor VI 9th', chordAt(S({ scale: 'Minor', chordType: 'Diatonic 9th' }), 5).name, 'G#maj9');
eq('C minor VII 9th', chordAt(S({ scale: 'Minor', chordType: 'Diatonic 9th' }), 6).name, 'A#9');
eq('fixed Major9 on iv', chordAt(S({ scale: 'Minor', chordType: 'Major9' }), 3).name, 'Fmaj9');
eq('A minor i', chordAt(S({ root: 9, scale: 'Minor' }), 0).name, 'Am');
eq('A minor root midi in C3..B3', chordAt(S({ root: 9, scale: 'Minor' }), 0).root, 57);
eq('octave +1', chordAt(S({ octave: 1 }), 0).root, 60);
eq('C iv in A minor stays low', chordAt(S({ root: 9, scale: 'Minor' }), 3).root, 50);

const c = chordAt(S(), 0), vc = defaultVoicing();
eq('5 voices triad doubles up', voice(c, vc).map(n => n.p), [48, 52, 55, 60, 64]);
eq('voice off', voice(c, { ...vc, on: [true, false, true, false, true] }).map(n => n.p), [48, 55, 64]);
eq('shift -12', voice(c, { ...vc, shift: [-12, 0, 0, 0, 0] })[0].p, 36);
eq('inversion 1', voice(c, { ...vc, invert: 1 }).map(n => n.p), [52, 55, 60, 64, 67]);

for (const p of PRESETS) {
  const st = S({ scale: p.scale }), sl = slotsOf(p), n = buildNotes(st, sl, vc, { style: 'Block', rate: 0.5, strum: 0.1 });
  eq('preset ' + p.name + ' notes', n.length, sl.length * VOICES);
}
const rp = randomProgression(16, (() => { let x = 7; return () => (x = (x * 16807) % 2147483647) / 2147483647; })());
eq('random fills 16 beats', totalBeats(rp), 16);
const arp = buildNotes(S(), [{ deg: 0, beats: 4 }], vc, { style: 'Arp Up', rate: 0.5, strum: 0 });
eq('arp 1/8 over 1 bar = 8 notes', arp.length, 8);
const str = buildNotes(S(), [{ deg: 0, beats: 4 }], vc, { style: 'Strum', rate: 0.5, strum: 0.2 });
eq('strum offsets', str.map(n => +n.s.toFixed(2)), [0, 0.2, 0.4, 0.6, 0.8]);
const mid = toMidi(buildNotes(S(), [{ deg: 0, beats: 4 }], vc, { style: 'Block', rate: 0.5, strum: 0 }), 120);
eq('midi header', String.fromCharCode(...mid.slice(0, 4)) + String.fromCharCode(...mid.slice(14, 18)), 'MThdMTrk');
console.log(fail ? fail + ' GAGAL' : 'semua lolos'); process.exit(fail ? 1 : 0);
