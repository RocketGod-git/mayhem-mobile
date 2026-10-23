export const BANDS = [
    { id: '160m', name: '160 m', lo: 1800000, hi: 2000000, mode: 'LSB', step: 500, calling: 1850000, segments: [[1800000, 1840000, 'CW / digital'], [1840000, 2000000, 'phone']] },
    { id: '80m', name: '80 m', lo: 3500000, hi: 4000000, mode: 'LSB', step: 500, calling: 3850000, segments: [[3500000, 3600000, 'CW / digital'], [3573000, 3576000, 'FT8'], [3600000, 4000000, 'phone']] },
    { id: '40m', name: '40 m', lo: 7000000, hi: 7300000, mode: 'LSB', step: 500, calling: 7200000, segments: [[7000000, 7125000, 'CW / digital'], [7074000, 7077000, 'FT8'], [7125000, 7300000, 'phone']] },
    { id: '30m', name: '30 m', lo: 10100000, hi: 10150000, mode: 'CW', step: 100, calling: 10136000, segments: [[10100000, 10130000, 'CW'], [10130000, 10150000, 'digital · FT8 10.136']] },
    { id: '20m', name: '20 m', lo: 14000000, hi: 14350000, mode: 'USB', step: 500, calling: 14074000, segments: [[14000000, 14150000, 'CW / digital'], [14074000, 14077000, 'FT8'], [14150000, 14350000, 'phone']] },
    { id: '17m', name: '17 m', lo: 18068000, hi: 18168000, mode: 'USB', step: 500, calling: 18100000, segments: [[18068000, 18110000, 'CW / digital'], [18110000, 18168000, 'phone']] },
    { id: '15m', name: '15 m', lo: 21000000, hi: 21450000, mode: 'USB', step: 500, calling: 21074000, segments: [[21000000, 21200000, 'CW / digital'], [21074000, 21077000, 'FT8'], [21200000, 21450000, 'phone']] },
    { id: '12m', name: '12 m', lo: 24890000, hi: 24990000, mode: 'USB', step: 500, calling: 24915000, segments: [[24890000, 24930000, 'CW / digital'], [24930000, 24990000, 'phone']] },
    { id: '10m', name: '10 m', lo: 28000000, hi: 29700000, mode: 'USB', step: 1000, offset: -100000, calling: 28400000, segments: [[28000000, 28300000, 'CW / digital'], [28074000, 28077000, 'FT8'], [28300000, 29000000, 'phone'], [29000000, 29700000, 'FM · repeaters 29.62–29.68']] },
    { id: '6m', name: '6 m', lo: 50000000, hi: 54000000, mode: 'USB', step: 1000, offset: -500000, calling: 50125000, segments: [[50000000, 50100000, 'CW'], [50100000, 50300000, 'SSB · 50.125 calling'], [50313000, 50316000, 'FT8'], [51000000, 54000000, 'FM · repeaters']] },
    { id: '2m', name: '2 m', lo: 144000000, hi: 148000000, mode: 'NFM', step: 12500, offset: -600000, calling: 146520000, segments: [[144000000, 144300000, 'CW / SSB · 144.200 calling'], [144174000, 144177000, 'FT8'], [144390000, 144390000, 'APRS'], [145100000, 145500000, 'repeater outputs (−600)'], [145800000, 146000000, 'satellites'], [146400000, 146600000, 'simplex · 146.520 calling'], [146610000, 147390000, 'repeaters (−/+600)'], [147420000, 147570000, 'simplex']] },
    { id: '1.25m', name: '1.25 m', lo: 222000000, hi: 225000000, mode: 'NFM', step: 20000, offset: -1600000, calling: 223500000, segments: [[222000000, 222150000, 'CW / SSB'], [223400000, 223520000, 'simplex · 223.500 calling'], [223850000, 224980000, 'repeaters (−1.6)']] },
    { id: '70cm', name: '70 cm', lo: 420000000, hi: 450000000, mode: 'NFM', step: 12500, offset: 5000000, calling: 446000000, segments: [[432000000, 432300000, 'CW / SSB · 432.100 calling'], [435000000, 438000000, 'satellites'], [442000000, 445000000, 'repeater outputs (+5)'], [445000000, 447000000, 'simplex · 446.000 calling'], [447000000, 450000000, 'repeater outputs (−5)']] },
    { id: '33cm', name: '33 cm', lo: 902000000, hi: 928000000, mode: 'NFM', step: 25000, offset: -12000000, calling: 927500000, segments: [[902000000, 928000000, 'shared with ISM']] },
    { id: '23cm', name: '23 cm', lo: 1240000000, hi: 1300000000, mode: 'NFM', step: 25000, offset: -20000000, calling: 1294500000, segments: [[1240000000, 1300000000, 'FM / ATV / repeaters']] },
];
export const NON_HAM = [
    { id: 'air', name: 'Air', lo: 118000000, hi: 137000000, mode: 'AM', step: 25000, calling: 121500000, segments: [[118000000, 137000000, 'AM · 121.500 guard']] },
    { id: 'wx', name: 'NOAA', lo: 162400000, hi: 162550000, mode: 'NFM', step: 25000, calling: 162400000, segments: [[162400000, 162550000, 'weather radio']] },
    { id: 'marine', name: 'Marine', lo: 156000000, hi: 162025000, mode: 'NFM', step: 25000, calling: 156800000, segments: [[156000000, 162025000, 'VHF marine · ch 16 = 156.800']] },
    { id: 'frs', name: 'FRS/GMRS', lo: 462550000, hi: 467725000, mode: 'NFM', step: 12500, calling: 462562500, segments: [[462550000, 462725000, 'ch 1–7 / 15–22'], [467562500, 467712500, 'ch 8–14']] },
];
export function bandOf(hz) { return BANDS.find(b => hz >= b.lo && hz <= b.hi) ?? NON_HAM.find(b => hz >= b.lo && hz <= b.hi); }
export function segmentOf(hz) {
    const b = bandOf(hz);
    if (!b)
        return '';
    const s = b.segments.find(([lo, hi]) => hz >= lo && hz <= hi);
    return s ? `${b.name} · ${s[2]}` : b.name;
}
const REPEATER_SEGMENTS = [
    [29620000, 29700000, -100000],
    [51620000, 51980000, -500000], [52500000, 52980000, -500000], [53000000, 53980000, -1000000],
    [145100000, 145500000, -600000], [146610000, 146995000, -600000], [147000000, 147390000, 600000],
    [223850000, 224980000, -1600000],
    [442000000, 445000000, 5000000], [447000000, 450000000, -5000000],
    [927000000, 928000000, -25000000],
    [1282000000, 1288000000, -12000000],
];
export function repeaterInput(hz) {
    const seg = REPEATER_SEGMENTS.find(([lo, hi]) => hz >= lo && hz <= hi);
    return seg ? hz + seg[2] : null;
}
