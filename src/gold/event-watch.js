import { createHash } from 'node:crypto';

const TRUSTED_DOMAINS = [
  'reuters.com', 'apnews.com', 'federalreserve.gov', 'treasury.gov', 'bls.gov', 'bea.gov',
  'state.gov', 'whitehouse.gov', 'un.org', 'iaea.org', 'nato.int', 'ecb.europa.eu',
];

const rumorPattern = /\b(claims?|reportedly|sources? say|says?|warns?|according to|rumou?r|unconfirmed|may have|could have|alleged)\b/i;
const escalationPattern = /\b(attack|airstrike|missile|drone strike|invasion|war|retaliat|mobiliz|blockade|explosion|sanctions?|nuclear threat|emergency)\b/i;
const deescalationPattern = /\b(ceasefire|peace deal|truce|de-escalat|withdrawal|talks resume|sanctions relief)\b/i;
const crisisPattern = /\b(bank failure|bank collapse|bank run|bailout|sovereign default|debt default|capital controls|liquidity crisis)\b/i;
const hawkishPattern = /\b(rate hike|raises? rates|hawkish|higher for longer|yields? (rise|jump|surge)|dollar (rise|jump|surge|strengthen))\b/i;
const dovishPattern = /\b(rate cut|cuts? rates|dovish|yields? (fall|drop|tumble)|dollar (fall|drop|tumble|weaken))\b/i;
const oilUpPattern = /\b(oil|brent|wti)\b.*\b(surge|jump|spike|soar|rally)\b|\b(surge|jump|spike|soar|rally)\b.*\b(oil|brent|wti)\b/i;
const oilDownPattern = /\b(oil|brent|wti)\b.*\b(fall|drop|tumble|slump)\b|\b(fall|drop|tumble|slump)\b.*\b(oil|brent|wti)\b/i;
const macroPattern = /\b(federal reserve|\bfed\b|fomc|inflation|\bcpi\b|\bpce\b|payrolls?|jobs report|unemployment|treasury yields?|real yields?|us dollar|dollar index)\b/i;
const geopoliticalContext = /\b(iran|israel|gaza|lebanon|houthi|yemen|saudi|gulf|hormuz|russia|ukraine|china|taiwan|north korea|united states|\bu\.s\.)\b/i;

const hostOf = (url) => {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
};

const isTrusted = (url) => {
  const host = hostOf(url);
  return TRUSTED_DOMAINS.some((domain) => host === domain || host.endsWith(`.${domain}`));
};

const reasonFor = ({ bullish, bearish }) => {
  if (bullish && bearish) return 'Competing safe-haven and rate/dollar forces make the immediate gold effect uncertain.';
  if (bullish) return 'The development can increase safe-haven demand or reduce the yield/dollar pressure that normally weighs on gold.';
  if (bearish) return 'The development can reduce safe-haven demand or increase the yield/dollar pressure that normally weighs on gold.';
  return 'The event is potentially material, but the immediate transmission to gold is not one-directional.';
};

export const assessGoldEvent = (article) => {
  const title = String(article?.title || '').replace(/\s+/g, ' ').trim();
  const url = String(article?.url || '').trim();
  if (!title || !url) return null;
  const trusted = isTrusted(url);
  const rumor = rumorPattern.test(title);
  const escalation = escalationPattern.test(title) && geopoliticalContext.test(title);
  const deescalation = deescalationPattern.test(title) && geopoliticalContext.test(title);
  const crisis = crisisPattern.test(title);
  const macro = macroPattern.test(title);
  const hawkish = hawkishPattern.test(title);
  const dovish = dovishPattern.test(title);
  const oilUp = oilUpPattern.test(title);
  const oilDown = oilDownPattern.test(title);

  let materiality = 0;
  if (escalation || deescalation || crisis) materiality += 6;
  if (macro && (hawkish || dovish)) materiality += 6;
  else if (macro) materiality += 2;
  if (oilUp || oilDown) materiality += 5;
  if (trusted) materiality += 2;
  if (rumor) materiality -= 1;
  if (materiality < 7) return null;

  const bullish = escalation || crisis || dovish || oilUp;
  const bearish = deescalation || hawkish || oilDown;
  const pressure = bullish && !bearish ? 'BULLISH' : bearish && !bullish ? 'BEARISH' : 'MIXED';
  const status = rumor
    ? 'CLAIM REPORTED; UNDERLYING EVENT NOT INDEPENDENTLY CONFIRMED'
    : trusted ? 'CONFIRMED REPORT FROM TRUSTED SOURCE' : 'SINGLE-SOURCE REPORT; NOT INDEPENDENTLY CONFIRMED';
  const confidence = trusted && !rumor ? 'HIGH' : trusted || !rumor ? 'MEDIUM' : 'LOW';
  if (confidence === 'LOW') return null;

  const rawDate = String(article?.seendate || article?.date || '');
  const normalizedDate = /^\d{8}T\d{6}Z$/.test(rawDate)
    ? rawDate.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z')
    : rawDate;
  const timestamp = Number.isFinite(Date.parse(normalizedDate)) ? Date.parse(normalizedDate) : Date.now();
  const normalizedTitle = title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const id = createHash('sha256').update(normalizedTitle).digest('hex').slice(0, 24);
  return { id, title, url, timestamp, pressure, status, confidence, reasoning: reasonFor({ bullish, bearish }) };
};

export class GoldEventWatch {
  constructor(config) {
    this.enabled = config.eventAlertsEnabled;
  }

  async latest() {
    if (!this.enabled) return [];
    const query = [
      '"Federal Reserve"', 'FOMC', '"Treasury yields"', '"US dollar"', 'inflation', 'payrolls',
      '"bank collapse"', '"sovereign default"', 'sanctions', 'ceasefire', 'missile', 'airstrike',
      '"Strait of Hormuz"', 'Houthi', 'Iran', 'Israel', 'Ukraine', 'Russia', 'Taiwan', 'oil',
    ].join(' OR ');
    const url = new URL('https://api.gdeltproject.org/api/v2/doc/doc');
    url.searchParams.set('query', `(${query})`);
    url.searchParams.set('mode', 'ArtList');
    url.searchParams.set('maxrecords', '50');
    url.searchParams.set('format', 'json');
    url.searchParams.set('timespan', '1h');
    url.searchParams.set('sort', 'DateDesc');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': 'CryptoNerd-GoldWatch/0.1' },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`GDELT HTTP ${response.status}`);
      const payload = await response.json();
      return (payload?.articles || []).map(assessGoldEvent).filter(Boolean).slice(0, 3);
    } finally {
      clearTimeout(timer);
    }
  }
}
