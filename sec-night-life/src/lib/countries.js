/**
 * ISO 3166-1 alpha-2 countries with their main ISO 4217 currency.
 * Names come from Intl.DisplayNames so they follow the app language when more are added.
 */
const COUNTRY_CURRENCY = `
AD:EUR AE:AED AF:AFN AG:XCD AI:XCD AL:ALL AM:AMD AO:AOA AR:ARS AS:USD AT:EUR AU:AUD AW:AWG AZ:AZN
BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:BGN BH:BHD BI:BIF BJ:XOF BM:BMD BN:BND BO:BOB BR:BRL BS:BSD
BT:BTN BW:BWP BY:BYN BZ:BZD CA:CAD CD:CDF CF:XAF CG:XAF CH:CHF CI:XOF CK:NZD CL:CLP CM:XAF CN:CNY
CO:COP CR:CRC CU:CUP CV:CVE CW:ANG CY:EUR CZ:CZK DE:EUR DJ:DJF DK:DKK DM:XCD DO:DOP DZ:DZD EC:USD
EE:EUR EG:EGP ER:ERN ES:EUR ET:ETB FI:EUR FJ:FJD FM:USD FO:DKK FR:EUR GA:XAF GB:GBP GD:XCD GE:GEL
GF:EUR GG:GBP GH:GHS GI:GIP GL:DKK GM:GMD GN:GNF GP:EUR GQ:XAF GR:EUR GT:GTQ GU:USD GW:XOF GY:GYD
HK:HKD HN:HNL HR:EUR HT:HTG HU:HUF ID:IDR IE:EUR IL:ILS IM:GBP IN:INR IQ:IQD IR:IRR IS:ISK IT:EUR
JE:GBP JM:JMD JO:JOD JP:JPY KE:KES KG:KGS KH:KHR KI:AUD KM:KMF KN:XCD KR:KRW KW:KWD KY:KYD KZ:KZT
LA:LAK LB:LBP LC:XCD LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR LU:EUR LV:EUR LY:LYD MA:MAD MC:EUR MD:MDL
ME:EUR MG:MGA MH:USD MK:MKD ML:XOF MM:MMK MN:MNT MO:MOP MP:USD MQ:EUR MR:MRU MS:XCD MT:EUR MU:MUR
MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN NA:NAD NC:XPF NE:XOF NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NR:AUD
NZ:NZD OM:OMR PA:PAB PE:PEN PF:XPF PG:PGK PH:PHP PK:PKR PL:PLN PR:USD PS:ILS PT:EUR PW:USD PY:PYG
QA:QAR RE:EUR RO:RON RS:RSD RU:RUB RW:RWF SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD SI:EUR SK:EUR
SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN SV:USD SX:ANG SY:SYP SZ:SZL TC:USD TD:XAF TG:XOF
TH:THB TJ:TJS TL:USD TM:TMT TN:TND TO:TOP TR:TRY TT:TTD TV:AUD TW:TWD TZ:TZS UA:UAH UG:UGX US:USD
UY:UYU UZ:UZS VA:EUR VC:XCD VE:VES VG:USD VI:USD VN:VND VU:VUV WS:WST XK:EUR YE:YER YT:EUR ZA:ZAR
ZM:ZMW ZW:USD
`
  .trim()
  .split(/\s+/)
  .map((pair) => pair.split(':'));

export const DEFAULT_COUNTRY_CODE = 'ZA';

const CURRENCY_BY_COUNTRY = Object.fromEntries(COUNTRY_CURRENCY);

let displayNames = null;
function regionNames(locale) {
  try {
    if (!displayNames || displayNames.locale !== locale) {
      displayNames = { locale, dn: new Intl.DisplayNames([locale], { type: 'region' }) };
    }
    return displayNames.dn;
  } catch {
    return null;
  }
}

export function normalizeCountryCode(value) {
  if (value == null) return null;
  const code = String(value).trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

export function countryName(code, locale = 'en') {
  const c = normalizeCountryCode(code);
  if (!c) return '';
  return regionNames(locale)?.of(c) || c;
}

/** Regional-indicator flag emoji for an ISO code. */
export function countryFlag(code) {
  const c = normalizeCountryCode(code);
  if (!c) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

export function currencyForCountry(code) {
  const c = normalizeCountryCode(code);
  return (c && CURRENCY_BY_COUNTRY[c]) || 'ZAR';
}

/** Every currency used by a country in the list (for the display-currency picker). */
export function allCountryCurrencies() {
  return [...new Set(COUNTRY_CURRENCY.map(([, cur]) => cur))];
}

/** Sorted country options for pickers. */
export function listCountries(locale = 'en') {
  return COUNTRY_CURRENCY.map(([code]) => ({
    code,
    name: countryName(code, locale),
    flag: countryFlag(code),
  })).sort((a, b) => a.name.localeCompare(b.name, locale));
}

/** Best-guess country from the browser locale (e.g. en-GB → GB). */
export function guessCountryFromBrowser() {
  if (typeof navigator === 'undefined') return null;
  const langs = [...(navigator.languages || []), navigator.language].filter(Boolean);
  for (const l of langs) {
    const m = /[-_]([A-Za-z]{2})$/.exec(String(l));
    if (m && CURRENCY_BY_COUNTRY[m[1].toUpperCase()]) return m[1].toUpperCase();
  }
  return null;
}

/** International dialling code per country (NANP members share +1). */
const DIAL_CODES = Object.fromEntries(
  `
AD:376 AE:971 AF:93 AG:1 AI:1 AL:355 AM:374 AO:244 AR:54 AS:1 AT:43 AU:61 AW:297 AZ:994
BA:387 BB:1 BD:880 BE:32 BF:226 BG:359 BH:973 BI:257 BJ:229 BM:1 BN:673 BO:591 BR:55 BS:1
BT:975 BW:267 BY:375 BZ:501 CA:1 CD:243 CF:236 CG:242 CH:41 CI:225 CK:682 CL:56 CM:237 CN:86
CO:57 CR:506 CU:53 CV:238 CW:599 CY:357 CZ:420 DE:49 DJ:253 DK:45 DM:1 DO:1 DZ:213 EC:593
EE:372 EG:20 ER:291 ES:34 ET:251 FI:358 FJ:679 FM:691 FO:298 FR:33 GA:241 GB:44 GD:1 GE:995
GF:594 GG:44 GH:233 GI:350 GL:299 GM:220 GN:224 GP:590 GQ:240 GR:30 GT:502 GU:1 GW:245 GY:592
HK:852 HN:504 HR:385 HT:509 HU:36 ID:62 IE:353 IL:972 IM:44 IN:91 IQ:964 IR:98 IS:354 IT:39
JE:44 JM:1 JO:962 JP:81 KE:254 KG:996 KH:855 KI:686 KM:269 KN:1 KR:82 KW:965 KY:1 KZ:7
LA:856 LB:961 LC:1 LI:423 LK:94 LR:231 LS:266 LT:370 LU:352 LV:371 LY:218 MA:212 MC:377 MD:373
ME:382 MG:261 MH:692 MK:389 ML:223 MM:95 MN:976 MO:853 MP:1 MQ:596 MR:222 MS:1 MT:356 MU:230
MV:960 MW:265 MX:52 MY:60 MZ:258 NA:264 NC:687 NE:227 NG:234 NI:505 NL:31 NO:47 NP:977 NR:674
NZ:64 OM:968 PA:507 PE:51 PF:689 PG:675 PH:63 PK:92 PL:48 PR:1 PS:970 PT:351 PW:680 PY:595
QA:974 RE:262 RO:40 RS:381 RU:7 RW:250 SA:966 SB:677 SC:248 SD:249 SE:46 SG:65 SI:386 SK:421
SL:232 SM:378 SN:221 SO:252 SR:597 SS:211 ST:239 SV:503 SX:1 SY:963 SZ:268 TC:1 TD:235 TG:228
TH:66 TJ:992 TL:670 TM:993 TN:216 TO:676 TR:90 TT:1 TV:688 TW:886 TZ:255 UA:380 UG:256 US:1
UY:598 UZ:998 VA:39 VC:1 VE:58 VG:1 VI:1 VN:84 VU:678 WS:685 XK:383 YE:967 YT:262 ZA:27
ZM:260 ZW:263
`
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(':')),
);

/** Country used when several share a dialling code and nothing else decides. */
const PRIMARY_FOR_DIAL_CODE = { 1: 'US', 7: 'RU', 44: 'GB', 39: 'IT', 262: 'RE' };

/** Countries whose national numbers keep the leading 0 after the country code. */
const KEEPS_TRUNK_ZERO = new Set(['IT', 'SM', 'VA']);

export function dialCodeForCountry(code) {
  const c = normalizeCountryCode(code);
  return (c && DIAL_CODES[c]) || null;
}

/**
 * Split a stored phone string into { countryCode, national }.
 * "+27 11 784 0330" → { countryCode: 'ZA', national: '11 784 0330' }.
 * Numbers without a leading "+" are treated as national numbers in preferredCountry.
 */
export function splitPhoneNumber(value, preferredCountry = DEFAULT_COUNTRY_CODE) {
  const preferred = normalizeCountryCode(preferredCountry) || DEFAULT_COUNTRY_CODE;
  const raw = String(value || '').trim();
  if (!raw) return { countryCode: preferred, national: '' };
  if (!raw.startsWith('+') && !raw.startsWith('00')) return { countryCode: preferred, national: raw };

  const afterPlus = raw.startsWith('+') ? raw.slice(1) : raw.slice(2);
  const digits = afterPlus.replace(/\D/g, '');
  let best = null;
  for (const len of [3, 2, 1]) {
    const prefix = digits.slice(0, len);
    const matches = Object.keys(DIAL_CODES).filter((c) => DIAL_CODES[c] === prefix);
    if (matches.length) {
      best = {
        dial: prefix,
        countryCode: matches.includes(preferred)
          ? preferred
          : PRIMARY_FOR_DIAL_CODE[prefix] && matches.includes(PRIMARY_FOR_DIAL_CODE[prefix])
            ? PRIMARY_FOR_DIAL_CODE[prefix]
            : matches[0],
      };
      break;
    }
  }
  if (!best) return { countryCode: preferred, national: raw };

  let seen = 0;
  let cut = 0;
  while (cut < afterPlus.length && seen < best.dial.length) {
    if (/\d/.test(afterPlus[cut])) seen += 1;
    cut += 1;
  }
  return { countryCode: best.countryCode, national: afterPlus.slice(cut).trim() };
}

/** Join a country and national number into "+<code> <number>", dropping the local trunk 0. */
export function joinPhoneNumber(countryCode, national) {
  const c = normalizeCountryCode(countryCode) || DEFAULT_COUNTRY_CODE;
  let rest = String(national || '').trim();
  if (!rest) return '';
  if (rest.startsWith('+') || rest.startsWith('00')) {
    const parsed = splitPhoneNumber(rest, c);
    return joinPhoneNumber(parsed.countryCode, parsed.national);
  }
  if (!KEEPS_TRUNK_ZERO.has(c)) rest = rest.replace(/^\(?0\)?\s*/, '');
  const dial = DIAL_CODES[c] || DIAL_CODES[DEFAULT_COUNTRY_CODE];
  return rest ? `+${dial} ${rest}` : '';
}

/** Rough centre per country for the map when the user has no coordinates. */
const COUNTRY_CENTER = {
  ZA: [-28.5, 24.7, 5],
  NA: [-22.6, 17.1, 5],
  BW: [-22.3, 24.7, 6],
  ZW: [-19.0, 29.2, 6],
  MZ: [-18.7, 35.5, 5],
  KE: [0.0, 37.9, 6],
  NG: [9.1, 8.7, 6],
  GH: [7.9, -1.0, 6],
  EG: [26.8, 30.8, 5],
  MA: [31.8, -7.1, 5],
  GB: [54.0, -2.5, 5],
  IE: [53.4, -8.2, 6],
  FR: [46.6, 2.2, 5],
  DE: [51.2, 10.4, 5],
  NL: [52.1, 5.3, 7],
  ES: [40.4, -3.7, 5],
  PT: [39.6, -8.0, 6],
  IT: [42.8, 12.6, 5],
  AE: [24.3, 54.4, 6],
  IN: [21.0, 78.9, 4],
  SG: [1.35, 103.8, 10],
  TH: [15.9, 100.9, 5],
  JP: [36.2, 138.3, 5],
  AU: [-25.3, 133.8, 4],
  NZ: [-41.0, 174.0, 5],
  US: [39.8, -98.6, 4],
  CA: [56.1, -106.3, 3],
  MX: [23.6, -102.6, 5],
  BR: [-14.2, -51.9, 4],
  AR: [-38.4, -63.6, 4],
};

export function countryMapCenter(code) {
  const c = normalizeCountryCode(code);
  const hit = c && COUNTRY_CENTER[c];
  if (hit) return { lat: hit[0], lng: hit[1], zoom: hit[2] };
  return null;
}
