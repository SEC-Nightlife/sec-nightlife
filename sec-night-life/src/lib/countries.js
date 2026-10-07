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
