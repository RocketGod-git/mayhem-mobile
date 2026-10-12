/** Lookup tables for the AIS vessel card: flag state from the MMSI's MID, ship types, navigation status, AtoN types. */

const MID: Record<number, string> = {
  201: 'Albania', 202: 'Andorra', 203: 'Austria', 204: 'Azores', 205: 'Belgium', 206: 'Belarus', 207: 'Bulgaria', 208: 'Vatican', 209: 'Cyprus', 210: 'Cyprus', 211: 'Germany', 212: 'Cyprus', 213: 'Georgia', 214: 'Moldova', 215: 'Malta', 216: 'Armenia', 218: 'Germany', 219: 'Denmark', 220: 'Denmark',
  224: 'Spain', 225: 'Spain', 226: 'France', 227: 'France', 228: 'France', 229: 'Malta', 230: 'Finland', 231: 'Faroe Islands', 232: 'United Kingdom', 233: 'United Kingdom', 234: 'United Kingdom', 235: 'United Kingdom', 236: 'Gibraltar', 237: 'Greece', 238: 'Croatia', 239: 'Greece', 240: 'Greece', 241: 'Greece', 242: 'Morocco', 243: 'Hungary', 244: 'Netherlands', 245: 'Netherlands', 246: 'Netherlands', 247: 'Italy', 248: 'Malta', 249: 'Malta', 250: 'Ireland', 251: 'Iceland', 252: 'Liechtenstein', 253: 'Luxembourg', 254: 'Monaco', 255: 'Madeira', 256: 'Malta', 257: 'Norway', 258: 'Norway', 259: 'Norway', 261: 'Poland', 262: 'Montenegro', 263: 'Portugal', 264: 'Romania', 265: 'Sweden', 266: 'Sweden', 267: 'Slovakia', 268: 'San Marino', 269: 'Switzerland', 270: 'Czechia', 271: 'Türkiye', 272: 'Ukraine', 273: 'Russia', 274: 'North Macedonia', 275: 'Latvia', 276: 'Estonia', 277: 'Lithuania', 278: 'Slovenia', 279: 'Serbia',
  301: 'Anguilla', 303: 'Alaska (USA)', 304: 'Antigua & Barbuda', 305: 'Antigua & Barbuda', 306: 'Curaçao / Sint Maarten', 307: 'Aruba', 308: 'Bahamas', 309: 'Bahamas', 310: 'Bermuda', 311: 'Bahamas', 312: 'Belize', 314: 'Barbados', 316: 'Canada', 319: 'Cayman Islands', 321: 'Costa Rica', 323: 'Cuba', 325: 'Dominica', 327: 'Dominican Republic', 329: 'Guadeloupe', 330: 'Grenada', 331: 'Greenland', 332: 'Guatemala', 334: 'Honduras', 336: 'Haiti', 338: 'USA', 339: 'Jamaica', 341: 'St Kitts & Nevis', 343: 'St Lucia', 345: 'Mexico', 347: 'Martinique', 348: 'Montserrat', 350: 'Nicaragua', 351: 'Panama', 352: 'Panama', 353: 'Panama', 354: 'Panama', 355: 'Panama', 356: 'Panama', 357: 'Panama', 358: 'Puerto Rico', 359: 'El Salvador', 361: 'St Pierre & Miquelon', 362: 'Trinidad & Tobago', 364: 'Turks & Caicos', 366: 'USA', 367: 'USA', 368: 'USA', 369: 'USA', 370: 'Panama', 371: 'Panama', 372: 'Panama', 373: 'Panama', 374: 'Panama', 375: 'St Vincent & Grenadines', 376: 'St Vincent & Grenadines', 377: 'St Vincent & Grenadines', 378: 'British Virgin Islands', 379: 'US Virgin Islands',
  401: 'Afghanistan', 403: 'Saudi Arabia', 405: 'Bangladesh', 408: 'Bahrain', 410: 'Bhutan', 412: 'China', 413: 'China', 414: 'China', 416: 'Taiwan', 417: 'Sri Lanka', 419: 'India', 422: 'Iran', 423: 'Azerbaijan', 425: 'Iraq', 428: 'Israel', 431: 'Japan', 432: 'Japan', 434: 'Turkmenistan', 436: 'Kazakhstan', 437: 'Uzbekistan', 438: 'Jordan', 440: 'South Korea', 441: 'South Korea', 443: 'Palestine', 445: 'North Korea', 447: 'Kuwait', 450: 'Lebanon', 451: 'Kyrgyzstan', 453: 'Macao', 455: 'Maldives', 457: 'Mongolia', 459: 'Nepal', 461: 'Oman', 463: 'Pakistan', 466: 'Qatar', 468: 'Syria', 470: 'UAE', 471: 'UAE', 472: 'Tajikistan', 473: 'Yemen', 475: 'Yemen', 477: 'Hong Kong', 478: 'Bosnia & Herzegovina',
  501: 'Adélie Land', 503: 'Australia', 506: 'Myanmar', 508: 'Brunei', 510: 'Micronesia', 511: 'Palau', 512: 'New Zealand', 514: 'Cambodia', 515: 'Cambodia', 516: 'Christmas Island', 518: 'Cook Islands', 520: 'Fiji', 523: 'Cocos Islands', 525: 'Indonesia', 529: 'Kiribati', 531: 'Laos', 533: 'Malaysia', 536: 'Northern Mariana Islands', 538: 'Marshall Islands', 540: 'New Caledonia', 542: 'Niue', 544: 'Nauru', 546: 'French Polynesia', 548: 'Philippines', 550: 'Timor-Leste', 553: 'Papua New Guinea', 555: 'Pitcairn', 557: 'Solomon Islands', 559: 'American Samoa', 561: 'Samoa', 563: 'Singapore', 564: 'Singapore', 565: 'Singapore', 566: 'Singapore', 567: 'Thailand', 570: 'Tonga', 572: 'Tuvalu', 574: 'Vietnam', 576: 'Vanuatu', 577: 'Vanuatu', 578: 'Wallis & Futuna',
  601: 'South Africa', 603: 'Angola', 605: 'Algeria', 607: 'St Paul & Amsterdam', 608: 'Ascension', 609: 'Burundi', 610: 'Benin', 611: 'Botswana', 612: 'Central African Republic', 613: 'Cameroon', 615: 'Congo', 616: 'Comoros', 617: 'Cabo Verde', 618: 'Crozet', 619: 'Côte d’Ivoire', 620: 'Comoros', 621: 'Djibouti', 622: 'Egypt', 624: 'Ethiopia', 625: 'Eritrea', 626: 'Gabon', 627: 'Ghana', 629: 'Gambia', 630: 'Guinea-Bissau', 631: 'Equatorial Guinea', 632: 'Guinea', 633: 'Burkina Faso', 634: 'Kenya', 635: 'Kerguelen', 636: 'Liberia', 637: 'Liberia', 638: 'South Sudan', 642: 'Libya', 644: 'Lesotho', 645: 'Mauritius', 647: 'Madagascar', 649: 'Mali', 650: 'Mozambique', 654: 'Mauritania', 655: 'Malawi', 656: 'Niger', 657: 'Nigeria', 659: 'Namibia', 660: 'Réunion', 661: 'Rwanda', 662: 'Sudan', 663: 'Senegal', 664: 'Seychelles', 665: 'St Helena', 666: 'Somalia', 667: 'Sierra Leone', 668: 'São Tomé & Príncipe', 669: 'Eswatini', 670: 'Chad', 671: 'Togo', 672: 'Tunisia', 674: 'Tanzania', 675: 'Uganda', 676: 'DR Congo', 677: 'Tanzania', 678: 'Zambia', 679: 'Zimbabwe',
  701: 'Argentina', 710: 'Brazil', 720: 'Bolivia', 725: 'Chile', 730: 'Colombia', 735: 'Ecuador', 740: 'Falkland Islands', 745: 'French Guiana', 750: 'Guyana', 755: 'Paraguay', 760: 'Peru', 765: 'Suriname', 770: 'Uruguay', 775: 'Venezuela',
};

/** Flag state (and what kind of MMSI it is) from the digits. */
export function mmsiInfo(mmsi: number): { flag?: string; kind: string } {
  const s = String(mmsi).padStart(9, '0');
  const mid = (at: number) => MID[Number(s.slice(at, at + 3))];
  if (s.startsWith('111')) return { flag: mid(3), kind: 'SAR aircraft' };
  if (s.startsWith('00')) return { flag: mid(2), kind: 'coast station' };
  if (s.startsWith('0')) return { flag: mid(1), kind: 'group of ships' };
  if (s.startsWith('99')) return { flag: mid(2), kind: 'aid to navigation' };
  if (s.startsWith('98')) return { flag: mid(2), kind: 'craft associated with a parent ship' };
  if (s.startsWith('970')) return { kind: 'AIS-SART' };
  if (s.startsWith('972')) return { kind: 'man overboard beacon' };
  if (s.startsWith('974')) return { kind: 'EPIRB' };
  return { flag: mid(0), kind: 'ship' };
}

const HAZARD = ['', ' · hazardous cat. A', ' · hazardous cat. B', ' · hazardous cat. C', ' · hazardous cat. D'];
/** AIS ship & cargo type code → words. */
export function shipTypeName(code?: number): string {
  if (code === undefined || code === 0) return '';
  const tens = Math.floor(code / 10), ones = code % 10;
  const special: Record<number, string> = { 30: 'Fishing', 31: 'Towing', 32: 'Towing (long / wide tow)', 33: 'Dredging / underwater ops', 34: 'Diving ops', 35: 'Military', 36: 'Sailing', 37: 'Pleasure craft', 50: 'Pilot vessel', 51: 'Search and rescue', 52: 'Tug', 53: 'Port tender', 54: 'Anti-pollution', 55: 'Law enforcement', 56: 'Spare (local)', 57: 'Spare (local)', 58: 'Medical transport', 59: 'Non-combatant ship' };
  if (special[code]) return special[code];
  const family: Record<number, string> = { 2: 'Wing in ground', 4: 'High-speed craft', 6: 'Passenger', 7: 'Cargo', 8: 'Tanker', 9: 'Other' };
  const f = family[tens]; if (!f) return `Type ${code}`;
  return f + (ones >= 1 && ones <= 4 ? HAZARD[ones] : ones === 9 ? ' (no additional info)' : '');
}

const NAV = ['Under way using engine', 'At anchor', 'Not under command', 'Restricted manoeuvrability', 'Constrained by draft', 'Moored', 'Aground', 'Engaged in fishing', 'Under way sailing', 'Reserved (HSC)', 'Reserved (WIG)', 'Towing astern', 'Pushing ahead / towing alongside', 'Reserved', 'AIS-SART / MOB / EPIRB active', ''];
export function navStatusName(code?: number): string { return code === undefined ? '' : NAV[code] ?? ''; }

const ATON = ['Unspecified', 'Reference point', 'RACON', 'Fixed offshore structure', 'Emergency wreck mark', 'Light, without sectors', 'Light, with sectors', 'Leading light front', 'Leading light rear', 'Beacon, cardinal N', 'Beacon, cardinal E', 'Beacon, cardinal S', 'Beacon, cardinal W', 'Beacon, port hand', 'Beacon, starboard hand', 'Beacon, preferred channel port', 'Beacon, preferred channel starboard', 'Beacon, isolated danger', 'Beacon, safe water', 'Beacon, special mark', 'Cardinal mark N', 'Cardinal mark E', 'Cardinal mark S', 'Cardinal mark W', 'Port hand mark', 'Starboard hand mark', 'Preferred channel port', 'Preferred channel starboard', 'Isolated danger', 'Safe water', 'Special mark', 'Light vessel / LANBY / rig'];
export function atonTypeName(code?: number): string { return code === undefined ? '' : ATON[code] ?? ''; }
