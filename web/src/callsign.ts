/**
 * Callsign know-how for the logbook: prefix → country / continent (offline, the common allocations), US call
 * areas, portable / DX-prefix parsing, Maidenhead grid squares with distance and bearing, and online lookups
 * (HamQTH's open DXCC service for entity and zones, hamdb.org and callook.info for name, QTH and grid).
 */

export interface CallInfo {
  call: string; base: string; prefix: string;
  country?: string; continent?: string; cq?: number; itu?: number; lat?: number; lon?: number; utc?: number;
  name?: string; qth?: string; grid?: string; class?: string; source: string;
}

// [prefix, country, continent] — longest prefix wins; a trailing ':' pins the following character class (digit)
const P: [string, string, string][] = [
  ['K', 'United States', 'NA'], ['N', 'United States', 'NA'], ['W', 'United States', 'NA'], ['AA', 'United States', 'NA'], ['AB', 'United States', 'NA'], ['AC', 'United States', 'NA'], ['AD', 'United States', 'NA'], ['AE', 'United States', 'NA'], ['AF', 'United States', 'NA'], ['AG', 'United States', 'NA'], ['AI', 'United States', 'NA'], ['AJ', 'United States', 'NA'], ['AK', 'United States', 'NA'], ['AL', 'United States', 'NA'],
  ['KH6', 'Hawaii', 'OC'], ['KH7', 'Hawaii', 'OC'], ['WH6', 'Hawaii', 'OC'], ['AH6', 'Hawaii', 'OC'], ['NH6', 'Hawaii', 'OC'], ['KL7', 'Alaska', 'NA'], ['KL', 'Alaska', 'NA'], ['AL7', 'Alaska', 'NA'], ['NL7', 'Alaska', 'NA'], ['WL7', 'Alaska', 'NA'], ['KP4', 'Puerto Rico', 'NA'], ['WP4', 'Puerto Rico', 'NA'], ['NP4', 'Puerto Rico', 'NA'], ['KP2', 'US Virgin Islands', 'NA'], ['KH2', 'Guam', 'OC'], ['KH0', 'Mariana Islands', 'OC'], ['KH8', 'American Samoa', 'OC'], ['KG4', 'Guantanamo Bay', 'NA'],
  ['VE', 'Canada', 'NA'], ['VA', 'Canada', 'NA'], ['VO', 'Canada', 'NA'], ['VY', 'Canada', 'NA'], ['CY', 'Canada', 'NA'], ['XE', 'Mexico', 'NA'], ['XF', 'Mexico', 'NA'], ['4A', 'Mexico', 'NA'], ['6D', 'Mexico', 'NA'],
  ['G', 'England', 'EU'], ['M', 'England', 'EU'], ['2E', 'England', 'EU'], ['GM', 'Scotland', 'EU'], ['MM', 'Scotland', 'EU'], ['2M', 'Scotland', 'EU'], ['GW', 'Wales', 'EU'], ['MW', 'Wales', 'EU'], ['2W', 'Wales', 'EU'], ['GI', 'Northern Ireland', 'EU'], ['MI', 'Northern Ireland', 'EU'], ['2I', 'Northern Ireland', 'EU'], ['GD', 'Isle of Man', 'EU'], ['MD', 'Isle of Man', 'EU'], ['GJ', 'Jersey', 'EU'], ['MJ', 'Jersey', 'EU'], ['GU', 'Guernsey', 'EU'], ['MU', 'Guernsey', 'EU'], ['EI', 'Ireland', 'EU'], ['EJ', 'Ireland', 'EU'],
  ['DA', 'Germany', 'EU'], ['DB', 'Germany', 'EU'], ['DC', 'Germany', 'EU'], ['DD', 'Germany', 'EU'], ['DE', 'Germany', 'EU'], ['DF', 'Germany', 'EU'], ['DG', 'Germany', 'EU'], ['DH', 'Germany', 'EU'], ['DJ', 'Germany', 'EU'], ['DK', 'Germany', 'EU'], ['DL', 'Germany', 'EU'], ['DM', 'Germany', 'EU'], ['DN', 'Germany', 'EU'], ['DO', 'Germany', 'EU'], ['DP', 'Germany', 'EU'], ['DR', 'Germany', 'EU'],
  ['F', 'France', 'EU'], ['TM', 'France', 'EU'], ['TK', 'Corsica', 'EU'], ['I', 'Italy', 'EU'], ['IS0', 'Sardinia', 'EU'], ['IT9', 'Sicily', 'EU'], ['EA', 'Spain', 'EU'], ['EB', 'Spain', 'EU'], ['EC', 'Spain', 'EU'], ['ED', 'Spain', 'EU'], ['EE', 'Spain', 'EU'], ['EF', 'Spain', 'EU'], ['EG', 'Spain', 'EU'], ['EH', 'Spain', 'EU'], ['EA6', 'Balearic Islands', 'EU'], ['EA8', 'Canary Islands', 'AF'], ['EA9', 'Ceuta & Melilla', 'AF'], ['CT', 'Portugal', 'EU'], ['CT3', 'Madeira', 'AF'], ['CU', 'Azores', 'EU'],
  ['PA', 'Netherlands', 'EU'], ['PB', 'Netherlands', 'EU'], ['PC', 'Netherlands', 'EU'], ['PD', 'Netherlands', 'EU'], ['PE', 'Netherlands', 'EU'], ['PF', 'Netherlands', 'EU'], ['PG', 'Netherlands', 'EU'], ['PH', 'Netherlands', 'EU'], ['PI', 'Netherlands', 'EU'], ['ON', 'Belgium', 'EU'], ['OO', 'Belgium', 'EU'], ['OP', 'Belgium', 'EU'], ['OQ', 'Belgium', 'EU'], ['OR', 'Belgium', 'EU'], ['OS', 'Belgium', 'EU'], ['OT', 'Belgium', 'EU'], ['LX', 'Luxembourg', 'EU'], ['HB', 'Switzerland', 'EU'], ['HB0', 'Liechtenstein', 'EU'], ['OE', 'Austria', 'EU'],
  ['SM', 'Sweden', 'EU'], ['SA', 'Sweden', 'EU'], ['SB', 'Sweden', 'EU'], ['SC', 'Sweden', 'EU'], ['SD', 'Sweden', 'EU'], ['SE', 'Sweden', 'EU'], ['SF', 'Sweden', 'EU'], ['SG', 'Sweden', 'EU'], ['SH', 'Sweden', 'EU'], ['SI', 'Sweden', 'EU'], ['SJ', 'Sweden', 'EU'], ['SK', 'Sweden', 'EU'], ['SL', 'Sweden', 'EU'], ['7S', 'Sweden', 'EU'], ['8S', 'Sweden', 'EU'], ['LA', 'Norway', 'EU'], ['LB', 'Norway', 'EU'], ['LC', 'Norway', 'EU'], ['LN', 'Norway', 'EU'], ['JW', 'Svalbard', 'EU'], ['JX', 'Jan Mayen', 'EU'], ['OZ', 'Denmark', 'EU'], ['OU', 'Denmark', 'EU'], ['OV', 'Denmark', 'EU'], ['5P', 'Denmark', 'EU'], ['5Q', 'Denmark', 'EU'], ['OY', 'Faroe Islands', 'EU'], ['OX', 'Greenland', 'NA'], ['OH', 'Finland', 'EU'], ['OG', 'Finland', 'EU'], ['OI', 'Finland', 'EU'], ['OJ0', 'Market Reef', 'EU'], ['OH0', 'Aland Islands', 'EU'], ['TF', 'Iceland', 'EU'],
  ['SP', 'Poland', 'EU'], ['SN', 'Poland', 'EU'], ['SO', 'Poland', 'EU'], ['SQ', 'Poland', 'EU'], ['SR', 'Poland', 'EU'], ['3Z', 'Poland', 'EU'], ['HF', 'Poland', 'EU'], ['OK', 'Czech Republic', 'EU'], ['OL', 'Czech Republic', 'EU'], ['OM', 'Slovakia', 'EU'], ['HA', 'Hungary', 'EU'], ['HG', 'Hungary', 'EU'], ['YO', 'Romania', 'EU'], ['YP', 'Romania', 'EU'], ['YQ', 'Romania', 'EU'], ['YR', 'Romania', 'EU'], ['LZ', 'Bulgaria', 'EU'], ['SV', 'Greece', 'EU'], ['SW', 'Greece', 'EU'], ['SX', 'Greece', 'EU'], ['SY', 'Greece', 'EU'], ['SZ', 'Greece', 'EU'], ['J4', 'Greece', 'EU'], ['SV5', 'Dodecanese', 'EU'], ['SV9', 'Crete', 'EU'], ['SV/A', 'Mount Athos', 'EU'], ['TA', 'Turkey', 'AS'], ['TB', 'Turkey', 'AS'], ['TC', 'Turkey', 'AS'], ['YM', 'Turkey', 'AS'], ['5B', 'Cyprus', 'AS'], ['C4', 'Cyprus', 'AS'], ['H2', 'Cyprus', 'AS'], ['P3', 'Cyprus', 'AS'], ['ZC4', 'UK Bases on Cyprus', 'AS'], ['9H', 'Malta', 'EU'], ['3A', 'Monaco', 'EU'], ['T7', 'San Marino', 'EU'], ['HV', 'Vatican', 'EU'], ['C3', 'Andorra', 'EU'], ['ZB2', 'Gibraltar', 'EU'],
  ['S5', 'Slovenia', 'EU'], ['9A', 'Croatia', 'EU'], ['E7', 'Bosnia-Herzegovina', 'EU'], ['YU', 'Serbia', 'EU'], ['YT', 'Serbia', 'EU'], ['4O', 'Montenegro', 'EU'], ['Z3', 'North Macedonia', 'EU'], ['Z6', 'Kosovo', 'EU'], ['ZA', 'Albania', 'EU'], ['LY', 'Lithuania', 'EU'], ['YL', 'Latvia', 'EU'], ['ES', 'Estonia', 'EU'], ['EU', 'Belarus', 'EU'], ['EV', 'Belarus', 'EU'], ['EW', 'Belarus', 'EU'], ['ER', 'Moldova', 'EU'], ['UR', 'Ukraine', 'EU'], ['US', 'Ukraine', 'EU'], ['UT', 'Ukraine', 'EU'], ['UU', 'Ukraine', 'EU'], ['UV', 'Ukraine', 'EU'], ['UW', 'Ukraine', 'EU'], ['UX', 'Ukraine', 'EU'], ['UY', 'Ukraine', 'EU'], ['UZ', 'Ukraine', 'EU'], ['EM', 'Ukraine', 'EU'], ['EN', 'Ukraine', 'EU'], ['EO', 'Ukraine', 'EU'],
  ['R', 'Russia', 'EU'], ['UA', 'Russia', 'EU'], ['UB', 'Russia', 'EU'], ['UC', 'Russia', 'EU'], ['UD', 'Russia', 'EU'], ['UE', 'Russia', 'EU'], ['UF', 'Russia', 'EU'], ['UG', 'Russia', 'EU'], ['UH', 'Russia', 'EU'], ['UI', 'Russia', 'EU'], ['UA9', 'Asiatic Russia', 'AS'], ['UA0', 'Asiatic Russia', 'AS'], ['R9', 'Asiatic Russia', 'AS'], ['R0', 'Asiatic Russia', 'AS'], ['UA2', 'Kaliningrad', 'EU'], ['R2F', 'Kaliningrad', 'EU'], ['UN', 'Kazakhstan', 'AS'], ['UP', 'Kazakhstan', 'AS'], ['UQ', 'Kazakhstan', 'AS'], ['EX', 'Kyrgyzstan', 'AS'], ['EY', 'Tajikistan', 'AS'], ['EZ', 'Turkmenistan', 'AS'], ['UK', 'Uzbekistan', 'AS'], ['UM', 'Uzbekistan', 'AS'], ['JT', 'Mongolia', 'AS'], ['EK', 'Armenia', 'AS'], ['4L', 'Georgia', 'AS'], ['4J', 'Azerbaijan', 'AS'], ['4K', 'Azerbaijan', 'AS'],
  ['JA', 'Japan', 'AS'], ['JE', 'Japan', 'AS'], ['JF', 'Japan', 'AS'], ['JG', 'Japan', 'AS'], ['JH', 'Japan', 'AS'], ['JI', 'Japan', 'AS'], ['JJ', 'Japan', 'AS'], ['JK', 'Japan', 'AS'], ['JL', 'Japan', 'AS'], ['JM', 'Japan', 'AS'], ['JN', 'Japan', 'AS'], ['JO', 'Japan', 'AS'], ['JP', 'Japan', 'AS'], ['JQ', 'Japan', 'AS'], ['JR', 'Japan', 'AS'], ['JS', 'Japan', 'AS'], ['7J', 'Japan', 'AS'], ['7K', 'Japan', 'AS'], ['7L', 'Japan', 'AS'], ['7M', 'Japan', 'AS'], ['7N', 'Japan', 'AS'], ['8J', 'Japan', 'AS'], ['8N', 'Japan', 'AS'], ['JD1', 'Ogasawara', 'AS'], ['HL', 'South Korea', 'AS'], ['DS', 'South Korea', 'AS'], ['DT', 'South Korea', 'AS'], ['6K', 'South Korea', 'AS'], ['6L', 'South Korea', 'AS'], ['6M', 'South Korea', 'AS'], ['6N', 'South Korea', 'AS'], ['BY', 'China', 'AS'], ['BA', 'China', 'AS'], ['BD', 'China', 'AS'], ['BG', 'China', 'AS'], ['BH', 'China', 'AS'], ['BI', 'China', 'AS'], ['BJ', 'China', 'AS'], ['BL', 'China', 'AS'], ['BT', 'China', 'AS'], ['BZ', 'China', 'AS'], ['BV', 'Taiwan', 'AS'], ['BM', 'Taiwan', 'AS'], ['BN', 'Taiwan', 'AS'], ['BO', 'Taiwan', 'AS'], ['BP', 'Taiwan', 'AS'], ['BQ', 'Taiwan', 'AS'], ['BU', 'Taiwan', 'AS'], ['BW', 'Taiwan', 'AS'], ['BX', 'Taiwan', 'AS'], ['VR2', 'Hong Kong', 'AS'], ['XX9', 'Macao', 'AS'],
  ['VU', 'India', 'AS'], ['AT', 'India', 'AS'], ['VU4', 'Andaman & Nicobar', 'AS'], ['VU7', 'Lakshadweep', 'AS'], ['AP', 'Pakistan', 'AS'], ['S2', 'Bangladesh', 'AS'], ['4S', 'Sri Lanka', 'AS'], ['9N', 'Nepal', 'AS'], ['A5', 'Bhutan', 'AS'], ['8Q', 'Maldives', 'AS'], ['XZ', 'Myanmar', 'AS'], ['HS', 'Thailand', 'AS'], ['E2', 'Thailand', 'AS'], ['XW', 'Laos', 'AS'], ['XU', 'Cambodia', 'AS'], ['XV', 'Vietnam', 'AS'], ['3W', 'Vietnam', 'AS'], ['9M2', 'West Malaysia', 'AS'], ['9M4', 'West Malaysia', 'AS'], ['9M6', 'East Malaysia', 'OC'], ['9M8', 'East Malaysia', 'OC'], ['9W', 'Malaysia', 'AS'], ['9V', 'Singapore', 'AS'], ['V8', 'Brunei', 'OC'], ['YB', 'Indonesia', 'OC'], ['YC', 'Indonesia', 'OC'], ['YD', 'Indonesia', 'OC'], ['YE', 'Indonesia', 'OC'], ['YF', 'Indonesia', 'OC'], ['YG', 'Indonesia', 'OC'], ['YH', 'Indonesia', 'OC'], ['7A', 'Indonesia', 'OC'], ['8A', 'Indonesia', 'OC'], ['4W', 'Timor-Leste', 'OC'], ['DU', 'Philippines', 'OC'], ['DV', 'Philippines', 'OC'], ['DW', 'Philippines', 'OC'], ['DX', 'Philippines', 'OC'], ['DY', 'Philippines', 'OC'], ['DZ', 'Philippines', 'OC'], ['4F', 'Philippines', 'OC'],
  ['VK', 'Australia', 'OC'], ['AX', 'Australia', 'OC'], ['VK9', 'Australian territories', 'OC'], ['VK0', 'Antarctica / Heard Is.', 'AN'], ['ZL', 'New Zealand', 'OC'], ['ZM', 'New Zealand', 'OC'], ['ZL7', 'Chatham Islands', 'OC'], ['ZL8', 'Kermadec Islands', 'OC'], ['ZL9', 'NZ Subantarctic Is.', 'OC'], ['P2', 'Papua New Guinea', 'OC'], ['H4', 'Solomon Islands', 'OC'], ['YJ', 'Vanuatu', 'OC'], ['FK', 'New Caledonia', 'OC'], ['3D2', 'Fiji', 'OC'], ['A3', 'Tonga', 'OC'], ['5W', 'Samoa', 'OC'], ['E5', 'Cook Islands', 'OC'], ['FO', 'French Polynesia', 'OC'], ['FW', 'Wallis & Futuna', 'OC'], ['T2', 'Tuvalu', 'OC'], ['T30', 'Western Kiribati', 'OC'], ['T31', 'Central Kiribati', 'OC'], ['T32', 'Eastern Kiribati', 'OC'], ['T33', 'Banaba', 'OC'], ['C2', 'Nauru', 'OC'], ['V7', 'Marshall Islands', 'OC'], ['V6', 'Micronesia', 'OC'], ['T8', 'Palau', 'OC'], ['KH5', 'Palmyra & Jarvis', 'OC'], ['KH9', 'Wake Island', 'OC'], ['KH1', 'Baker & Howland', 'OC'], ['KH3', 'Johnston Island', 'OC'], ['KH4', 'Midway Island', 'OC'],
  ['LU', 'Argentina', 'SA'], ['AY', 'Argentina', 'SA'], ['AZ', 'Argentina', 'SA'], ['L2', 'Argentina', 'SA'], ['L3', 'Argentina', 'SA'], ['L4', 'Argentina', 'SA'], ['L5', 'Argentina', 'SA'], ['L6', 'Argentina', 'SA'], ['L7', 'Argentina', 'SA'], ['L8', 'Argentina', 'SA'], ['L9', 'Argentina', 'SA'], ['LO', 'Argentina', 'SA'], ['LP', 'Argentina', 'SA'], ['LQ', 'Argentina', 'SA'], ['LR', 'Argentina', 'SA'], ['LS', 'Argentina', 'SA'], ['LT', 'Argentina', 'SA'], ['LV', 'Argentina', 'SA'], ['LW', 'Argentina', 'SA'], ['PY', 'Brazil', 'SA'], ['PP', 'Brazil', 'SA'], ['PQ', 'Brazil', 'SA'], ['PR', 'Brazil', 'SA'], ['PS', 'Brazil', 'SA'], ['PT', 'Brazil', 'SA'], ['PU', 'Brazil', 'SA'], ['PV', 'Brazil', 'SA'], ['PW', 'Brazil', 'SA'], ['PX', 'Brazil', 'SA'], ['ZV', 'Brazil', 'SA'], ['ZW', 'Brazil', 'SA'], ['ZX', 'Brazil', 'SA'], ['ZY', 'Brazil', 'SA'], ['ZZ', 'Brazil', 'SA'], ['PY0F', 'Fernando de Noronha', 'SA'], ['CE', 'Chile', 'SA'], ['CA', 'Chile', 'SA'], ['CB', 'Chile', 'SA'], ['CC', 'Chile', 'SA'], ['CD', 'Chile', 'SA'], ['XQ', 'Chile', 'SA'], ['XR', 'Chile', 'SA'], ['3G', 'Chile', 'SA'], ['CE0Y', 'Easter Island', 'SA'], ['CE0Z', 'Juan Fernandez', 'SA'], ['HK', 'Colombia', 'SA'], ['HJ', 'Colombia', 'SA'], ['5J', 'Colombia', 'SA'], ['5K', 'Colombia', 'SA'], ['HK0', 'San Andres', 'NA'], ['YV', 'Venezuela', 'SA'], ['YW', 'Venezuela', 'SA'], ['YX', 'Venezuela', 'SA'], ['YY', 'Venezuela', 'SA'], ['4M', 'Venezuela', 'SA'], ['HC', 'Ecuador', 'SA'], ['HD', 'Ecuador', 'SA'], ['HC8', 'Galapagos', 'SA'], ['OA', 'Peru', 'SA'], ['OB', 'Peru', 'SA'], ['OC', 'Peru', 'SA'], ['4T', 'Peru', 'SA'], ['CP', 'Bolivia', 'SA'], ['ZP', 'Paraguay', 'SA'], ['CX', 'Uruguay', 'SA'], ['CV', 'Uruguay', 'SA'], ['CW', 'Uruguay', 'SA'], ['PZ', 'Suriname', 'SA'], ['8R', 'Guyana', 'SA'], ['FY', 'French Guiana', 'SA'], ['VP8', 'Falkland Islands', 'SA'],
  ['TI', 'Costa Rica', 'NA'], ['TE', 'Costa Rica', 'NA'], ['TI9', 'Cocos Island', 'NA'], ['HP', 'Panama', 'NA'], ['HO', 'Panama', 'NA'], ['H3', 'Panama', 'NA'], ['3E', 'Panama', 'NA'], ['YN', 'Nicaragua', 'NA'], ['H6', 'Nicaragua', 'NA'], ['H7', 'Nicaragua', 'NA'], ['HR', 'Honduras', 'NA'], ['HQ', 'Honduras', 'NA'], ['YS', 'El Salvador', 'NA'], ['HU', 'El Salvador', 'NA'], ['TG', 'Guatemala', 'NA'], ['TD', 'Guatemala', 'NA'], ['V3', 'Belize', 'NA'], ['CO', 'Cuba', 'NA'], ['CM', 'Cuba', 'NA'], ['T4', 'Cuba', 'NA'], ['HI', 'Dominican Republic', 'NA'], ['HH', 'Haiti', 'NA'], ['4V', 'Haiti', 'NA'], ['6Y', 'Jamaica', 'NA'], ['C6', 'Bahamas', 'NA'], ['ZF', 'Cayman Islands', 'NA'], ['VP5', 'Turks & Caicos', 'NA'], ['VP9', 'Bermuda', 'NA'], ['V2', 'Antigua & Barbuda', 'NA'], ['V4', 'St Kitts & Nevis', 'NA'], ['J3', 'Grenada', 'NA'], ['J6', 'St Lucia', 'NA'], ['J7', 'Dominica', 'NA'], ['J8', 'St Vincent', 'NA'], ['8P', 'Barbados', 'NA'], ['9Y', 'Trinidad & Tobago', 'SA'], ['9Z', 'Trinidad & Tobago', 'SA'], ['VP2E', 'Anguilla', 'NA'], ['VP2M', 'Montserrat', 'NA'], ['VP2V', 'British Virgin Islands', 'NA'], ['FG', 'Guadeloupe', 'NA'], ['FM', 'Martinique', 'NA'], ['FJ', 'St Barthelemy', 'NA'], ['FS', 'St Martin', 'NA'], ['PJ2', 'Curacao', 'SA'], ['PJ4', 'Bonaire', 'SA'], ['PJ5', 'St Eustatius', 'NA'], ['PJ6', 'Saba', 'NA'], ['PJ7', 'Sint Maarten', 'NA'], ['P4', 'Aruba', 'SA'], ['FP', 'St Pierre & Miquelon', 'NA'],
  ['ZS', 'South Africa', 'AF'], ['ZR', 'South Africa', 'AF'], ['ZT', 'South Africa', 'AF'], ['ZU', 'South Africa', 'AF'], ['ZS8', 'Marion Island', 'AF'], ['V5', 'Namibia', 'AF'], ['A2', 'Botswana', 'AF'], ['Z2', 'Zimbabwe', 'AF'], ['9J', 'Zambia', 'AF'], ['7Q', 'Malawi', 'AF'], ['C9', 'Mozambique', 'AF'], ['3DA', 'Eswatini', 'AF'], ['7P', 'Lesotho', 'AF'], ['5R', 'Madagascar', 'AF'], ['3B8', 'Mauritius', 'AF'], ['3B9', 'Rodrigues', 'AF'], ['FR', 'Reunion', 'AF'], ['FH', 'Mayotte', 'AF'], ['D6', 'Comoros', 'AF'], ['S7', 'Seychelles', 'AF'], ['5H', 'Tanzania', 'AF'], ['5Z', 'Kenya', 'AF'], ['5X', 'Uganda', 'AF'], ['9X', 'Rwanda', 'AF'], ['9U', 'Burundi', 'AF'], ['ET', 'Ethiopia', 'AF'], ['E3', 'Eritrea', 'AF'], ['J2', 'Djibouti', 'AF'], ['6O', 'Somalia', 'AF'], ['T5', 'Somalia', 'AF'], ['ST', 'Sudan', 'AF'], ['Z8', 'South Sudan', 'AF'], ['SU', 'Egypt', 'AF'], ['5A', 'Libya', 'AF'], ['3V', 'Tunisia', 'AF'], ['7X', 'Algeria', 'AF'], ['CN', 'Morocco', 'AF'], ['5T', 'Mauritania', 'AF'], ['TZ', 'Mali', 'AF'], ['5U', 'Niger', 'AF'], ['TT', 'Chad', 'AF'], ['6W', 'Senegal', 'AF'], ['C5', 'The Gambia', 'AF'], ['J5', 'Guinea-Bissau', 'AF'], ['3X', 'Guinea', 'AF'], ['9L', 'Sierra Leone', 'AF'], ['EL', 'Liberia', 'AF'], ['TU', 'Cote d\'Ivoire', 'AF'], ['9G', 'Ghana', 'AF'], ['5V', 'Togo', 'AF'], ['TY', 'Benin', 'AF'], ['5N', 'Nigeria', 'AF'], ['XT', 'Burkina Faso', 'AF'], ['TJ', 'Cameroon', 'AF'], ['TL', 'Central African Rep.', 'AF'], ['TR', 'Gabon', 'AF'], ['TN', 'Congo', 'AF'], ['9Q', 'DR Congo', 'AF'], ['3C', 'Equatorial Guinea', 'AF'], ['S9', 'Sao Tome & Principe', 'AF'], ['D2', 'Angola', 'AF'], ['D4', 'Cape Verde', 'AF'], ['ZD7', 'St Helena', 'AF'], ['ZD8', 'Ascension Island', 'AF'], ['ZD9', 'Tristan da Cunha', 'AF'],
  ['4X', 'Israel', 'AS'], ['4Z', 'Israel', 'AS'], ['JY', 'Jordan', 'AS'], ['OD', 'Lebanon', 'AS'], ['YK', 'Syria', 'AS'], ['YI', 'Iraq', 'AS'], ['EP', 'Iran', 'AS'], ['EQ', 'Iran', 'AS'], ['HZ', 'Saudi Arabia', 'AS'], ['7Z', 'Saudi Arabia', 'AS'], ['9K', 'Kuwait', 'AS'], ['A9', 'Bahrain', 'AS'], ['A7', 'Qatar', 'AS'], ['A6', 'UAE', 'AS'], ['A4', 'Oman', 'AS'], ['7O', 'Yemen', 'AS'], ['YA', 'Afghanistan', 'AS'], ['T6', 'Afghanistan', 'AS'], ['E4', 'Palestine', 'AS'], ['KC4', 'Antarctica', 'AN'],
];
const PREFIXES = P.sort((a, b) => b[0].length - a[0].length);

const US_AREAS: Record<string, string> = { '1': 'New England', '2': 'New York / New Jersey', '3': 'Pennsylvania / Delaware / Maryland / DC', '4': 'Southeast', '5': 'South Central', '6': 'California', '7': 'Northwest / Mountain', '8': 'Michigan / Ohio / West Virginia', '9': 'Illinois / Indiana / Wisconsin', '0': 'Midwest' };

/** Split "VE3/W1AW/P" into the home call, the DX prefix it is operating under and the portable designator. */
export function parseCall(raw: string): { call: string; base: string; prefix: string; portable: string } {
  const call = raw.trim().toUpperCase().replace(/[^A-Z0-9/]/g, '');
  const parts = call.split('/').filter(Boolean);
  if (!parts.length) return { call: '', base: '', prefix: '', portable: '' };
  const portables: string[] = [];
  while (parts.length > 1 && /^(P|M|MM|AM|QRP|A|R|B|J|LH|\d)$/.test(parts[parts.length - 1])) portables.unshift(parts.pop()!);
  const looksLikeCall = (s: string) => /^[A-Z0-9]{1,3}\d[A-Z]{1,4}$/.test(s) || /^\d[A-Z]\d[A-Z]{1,4}$/.test(s);
  let base = parts[0], prefix = '';
  if (parts.length >= 2) {
    const [a, b] = parts;
    if (looksLikeCall(a) && looksLikeCall(b)) { base = a.length >= b.length ? a : b; prefix = base === a ? b : a; }
    else if (looksLikeCall(b)) { base = b; prefix = a; }
    else { base = a; prefix = b; }
  }
  const m = base.match(/^([A-Z0-9]{1,3}?\d)/);
  return { call, base, prefix: prefix || (m ? m[1] : base.slice(0, 2)), portable: portables.join('/') };
}

/** Offline entity from the prefix (or the DX prefix when there is one). */
export function offlineInfo(raw: string): CallInfo {
  const p = parseCall(raw);
  const key = p.prefix && p.prefix !== p.base.slice(0, p.prefix.length) ? p.prefix : p.base;
  let hit: [string, string, string] | undefined;
  for (const e of PREFIXES) if (key.startsWith(e[0])) { hit = e; break; }
  const info: CallInfo = { call: p.call, base: p.base, prefix: p.prefix, source: 'prefix table' };
  if (hit) {
    info.country = hit[1]; info.continent = hit[2];
    if (hit[1] === 'United States') { const d = p.base.match(/\d/)?.[0]; if (d && US_AREAS[d]) info.qth = `call area ${d} · ${US_AREAS[d]}`; }
  }
  if (p.portable) info.qth = `${info.qth ? info.qth + ' · ' : ''}/${p.portable}`;
  return info;
}

// ------------------------------------------------------------------------------------------ Maidenhead
export function gridToLatLon(grid: string): { lat: number; lon: number } | null {
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}\d{2}([A-X]{2}(\d{2})?)?$/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180, lat = (g.charCodeAt(1) - 65) * 10 - 90;
  lon += Number(g[2]) * 2; lat += Number(g[3]);
  if (g.length >= 6) { lon += (g.charCodeAt(4) - 65) * 2 / 24; lat += (g.charCodeAt(5) - 65) / 24; }
  if (g.length >= 8) { lon += Number(g[6]) * 2 / 240; lat += Number(g[7]) / 240; }
  // center of the square
  const w = g.length >= 8 ? 2 / 240 : g.length >= 6 ? 2 / 24 : 2, h = g.length >= 8 ? 1 / 240 : g.length >= 6 ? 1 / 24 : 1;
  return { lat: lat + h / 2, lon: lon + w / 2 };
}
export function latLonToGrid(lat: number, lon: number, len = 6): string {
  lon += 180; lat += 90;
  let g = String.fromCharCode(65 + Math.floor(lon / 20)) + String.fromCharCode(65 + Math.floor(lat / 10));
  lon %= 20; lat %= 10;
  g += Math.floor(lon / 2) + '' + Math.floor(lat);
  if (len >= 6) { lon %= 2; lat %= 1; g += String.fromCharCode(97 + Math.floor(lon * 12)) + String.fromCharCode(97 + Math.floor(lat * 24)); }
  if (len >= 8) { lon = (lon * 12) % 1; lat = (lat * 24) % 1; g += Math.floor(lon * 10) + '' + Math.floor(lat * 10); }
  return g;
}
/** Great-circle distance (km) and initial bearing (°) from 1 to 2. */
export function distanceBearing(lat1: number, lon1: number, lat2: number, lon2: number): { km: number; deg: number } {
  const r = Math.PI / 180, φ1 = lat1 * r, φ2 = lat2 * r, dλ = (lon2 - lon1) * r;
  const a = Math.sin((φ2 - φ1) / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  const km = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dλ) * Math.cos(φ2), x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return { km, deg: (Math.atan2(y, x) / r + 360) % 360 };
}

// ------------------------------------------------------------------------------------------ online
async function fetchText(url: string, ms = 7000): Promise<string> {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.text(); } finally { clearTimeout(t); }
}
const xmlField = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim();

/** Merge the free online sources over the offline guess. Never throws; `source` says what answered. */
export async function lookupCall(raw: string): Promise<CallInfo> {
  const info = offlineInfo(raw);
  const call = info.base || info.call;
  if (!call) return info;
  const sources: string[] = [];
  const [dxcc, hamdb, callook] = await Promise.allSettled([
    fetchText(`https://www.hamqth.com/dxcc.php?callsign=${encodeURIComponent(call)}`),
    fetchText(`https://api.hamdb.org/v1/${encodeURIComponent(call)}/json/mayhem-mobile`),
    info.country === 'United States' || info.country === 'Hawaii' || info.country === 'Alaska' || info.country === 'Puerto Rico' ? fetchText(`https://callook.info/${encodeURIComponent(call)}/json`) : Promise.reject(new Error('not US')),
  ]);
  if (dxcc.status === 'fulfilled' && dxcc.value.includes('<dxcc>')) {
    const x = dxcc.value;
    const name = xmlField(x, 'name'), cont = xmlField(x, 'continent'), cq = xmlField(x, 'cq'), itu = xmlField(x, 'itu'), lat = xmlField(x, 'lat'), lon = xmlField(x, 'lng'), utc = xmlField(x, 'utc');
    if (name) { info.country = name; sources.push('HamQTH'); }
    if (cont) info.continent = cont; if (cq) info.cq = Number(cq); if (itu) info.itu = Number(itu);
    if (lat && lon) { info.lat = Number(lat); info.lon = Number(lon); } if (utc) info.utc = Number(utc);
  }
  if (hamdb.status === 'fulfilled') {
    try {
      const j = JSON.parse(hamdb.value).hamdb?.callsign;
      if (j && j.call && j.call !== 'NOT_FOUND') {
        const nm = [j.fname, j.name].filter((s: string) => s && s !== 'NOT_FOUND').join(' ').trim();
        if (nm) info.name = nm;
        const q = [j.addr2, j.state, j.country].filter((s: string) => s && s !== 'NOT_FOUND').join(', ');
        if (q) info.qth = q;
        if (j.grid && j.grid !== 'NOT_FOUND') info.grid = j.grid;
        if (j.class && j.class !== 'NOT_FOUND') info.class = j.class;
        if (j.lat && j.lon && j.lat !== 'NOT_FOUND') { info.lat = Number(j.lat); info.lon = Number(j.lon); }
        sources.push('hamdb');
      }
    } catch { /* ignore */ }
  }
  if (callook.status === 'fulfilled') {
    try {
      const j = JSON.parse(callook.value);
      if (j.status === 'VALID') {
        if (j.name) info.name = j.name;
        const a = j.address ?? {}; const q = [a.line2].filter(Boolean).join(', '); if (q) info.qth = q;
        if (j.location?.gridsquare) info.grid = j.location.gridsquare;
        if (j.location?.latitude && j.location?.longitude) { info.lat = Number(j.location.latitude); info.lon = Number(j.location.longitude); }
        if (j.current?.operClass) info.class = j.current.operClass.toLowerCase();
        if (j.type === 'CLUB') info.class = 'club';
        sources.push('callook');
      }
    } catch { /* ignore */ }
  }
  info.source = sources.length ? sources.join(' + ') : `${info.source} (offline)`;
  return info;
}

// ------------------------------------------------------------------------------------------ bands / ADIF
export function bandOfHz(hz: number): string {
  const m = hz / 1e6;
  const t: [number, number, string][] = [[1.8, 2, '160m'], [3.5, 4, '80m'], [5.3, 5.4, '60m'], [7, 7.3, '40m'], [10.1, 10.15, '30m'], [14, 14.35, '20m'], [18.068, 18.168, '17m'], [21, 21.45, '15m'], [24.89, 24.99, '12m'], [28, 29.7, '10m'], [50, 54, '6m'], [70, 71, '4m'], [144, 148, '2m'], [222, 225, '1.25m'], [420, 450, '70cm'], [902, 928, '33cm'], [1240, 1300, '23cm'], [2300, 2450, '13cm'], [3300, 3500, '9cm'], [5650, 5925, '6cm']];
  for (const [lo, hi, b] of t) if (m >= lo && m <= hi) return b;
  return '';
}
export interface Qso { id: string; call: string; ts: number; freq: number; mode: string; rstS: string; rstR: string; name: string; qth: string; grid: string; notes: string; country?: string }
const ADIF_MODES: Record<string, [string, string]> = { NFM: ['FM', ''], FM: ['FM', ''], USB: ['SSB', 'USB'], LSB: ['SSB', 'LSB'], SSB: ['SSB', ''], CW: ['CW', ''], AM: ['AM', ''], FT8: ['FT8', ''], PSK31: ['PSK', 'PSK31'], RTTY: ['RTTY', ''], SSTV: ['SSTV', ''], DMR: ['DIGITALVOICE', 'DMR'], APRS: ['PKT', ''] };
export function toAdif(qsos: Qso[], myCall: string, myGrid: string): string {
  const f = (k: string, v: string | number | undefined) => v === undefined || v === '' ? '' : `<${k}:${String(v).length}>${v}`;
  const head = `Mayhem Mobile logbook\n${f('ADIF_VER', '3.1.4')}${f('PROGRAMID', 'MayhemMobile')}<EOH>\n`;
  return head + qsos.map(q => {
    const d = new Date(q.ts), date = d.toISOString().slice(0, 10).replace(/-/g, ''), time = d.toISOString().slice(11, 16).replace(':', '');
    const [mode, sub] = ADIF_MODES[q.mode.toUpperCase()] ?? [q.mode.toUpperCase(), ''];
    return f('CALL', q.call) + f('QSO_DATE', date) + f('TIME_ON', time) + f('BAND', bandOfHz(q.freq)) + f('FREQ', (q.freq / 1e6).toFixed(6)) + f('MODE', mode) + f('SUBMODE', sub) + f('RST_SENT', q.rstS) + f('RST_RCVD', q.rstR) + f('NAME', q.name) + f('QTH', q.qth) + f('GRIDSQUARE', q.grid) + f('COUNTRY', q.country) + f('COMMENT', q.notes) + f('STATION_CALLSIGN', myCall) + f('MY_GRIDSQUARE', myGrid) + '<EOR>';
  }).join('\n') + '\n';
}
export function fromAdif(text: string): Qso[] {
  const body = text.includes('<EOH>') ? text.slice(text.indexOf('<EOH>') + 5) : text;
  const out: Qso[] = [];
  for (const rec of body.split(/<EOR>/i)) {
    const fields: Record<string, string> = {};
    const re = /<([A-Za-z_]+):(\d+)(?::[^>]*)?>/g; let m: RegExpExecArray | null;
    while ((m = re.exec(rec))) { const k = m[1].toUpperCase(), n = Number(m[2]); fields[k] = rec.substr(m.index + m[0].length, n); }
    if (!fields.CALL) continue;
    const date = fields.QSO_DATE ?? '19700101', time = (fields.TIME_ON ?? '0000').padEnd(6, '0');
    const ts = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(4, 6)) - 1, Number(date.slice(6, 8)), Number(time.slice(0, 2)), Number(time.slice(2, 4)), Number(time.slice(4, 6)));
    const mode = fields.SUBMODE || fields.MODE || '';
    out.push({ id: `${ts}-${fields.CALL}`, call: fields.CALL.toUpperCase(), ts, freq: fields.FREQ ? Math.round(Number(fields.FREQ) * 1e6) : 0, mode: mode === 'SSB' ? 'USB' : mode === 'FM' ? 'NFM' : mode, rstS: fields.RST_SENT ?? '', rstR: fields.RST_RCVD ?? '', name: fields.NAME ?? '', qth: fields.QTH ?? '', grid: fields.GRIDSQUARE ?? '', notes: fields.COMMENT ?? fields.NOTES ?? '', country: fields.COUNTRY });
  }
  return out;
}
