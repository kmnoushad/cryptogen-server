import { requestJson } from './http.js';

const number = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isOne = value => String(value ?? '') === '1' || value === true;
const statusOne = value => isOne(value?.status ?? value?.value ?? value);
const systemTag = tag => /burn|dead|lock|bridge|pool|pair|router|exchange|binance|gate|mexc|mxc|bithumb|coinbase|okx|bybit/i.test(String(tag ?? ''));

const concentration = holders => {
  const rows = Array.isArray(holders) ? holders : [];
  const risky = rows.filter(holder => !isOne(holder.is_locked) && !systemTag(holder.tag));
  const top = risky.reduce((max, holder) => Math.max(max, number(holder.percent) ?? 0), 0);
  const top10 = risky.reduce((sum, holder) => sum + (number(holder.percent) ?? 0), 0);
  return { top, top10 };
};

const finish = ({ critical, warnings, metrics, raw, coverage = 'SUPPORTED' }) => {
  const riskScore = Math.min(10, critical.length * 5 + warnings.reduce((sum, item) => sum + item.points, 0));
  const rating = critical.length
    ? 'BLOCKED'
    : riskScore >= 3
      ? 'POSSIBLE_RUG'
      : riskScore > 0
        ? 'CAUTION'
        : 'NO_CRITICAL_FLAGS';
  return {
    coverage,
    rating,
    riskScore,
    hardBlock: critical.length > 0,
    critical,
    warnings: warnings.map(item => item.text),
    metrics,
    checkedAt: Date.now(),
    raw,
  };
};

export const assessEvmToken = raw => {
  const critical = [];
  const warnings = [];
  const warn = (points, text) => warnings.push({ points, text });
  const hard = text => critical.push(text);
  const sellTax = number(raw?.sell_tax);
  const buyTax = number(raw?.buy_tax);
  const ownerPercent = number(raw?.owner_percent) ?? 0;
  const creatorPercent = number(raw?.creator_percent) ?? 0;
  const holders = concentration(raw?.holders);
  const lpRows = Array.isArray(raw?.lp_holders) ? raw.lp_holders : [];
  const unlockedLp = lpRows.filter(x => !isOne(x.is_locked) && !systemTag(x.tag))
    .reduce((sum, x) => sum + (number(x.percent) ?? 0), 0);

  if (isOne(raw?.is_honeypot)) hard('honeypot detected');
  if (isOne(raw?.cannot_buy)) hard('contract may block buying');
  if (isOne(raw?.cannot_sell_all)) hard('contract restricts selling');
  if (sellTax !== null && sellTax >= 0.15) hard(`sell tax ${(sellTax * 100).toFixed(0)}%`);
  if (isOne(raw?.owner_change_balance)) hard('owner can alter holder balances');
  if (isOne(raw?.hidden_owner)) hard('hidden owner detected');
  if (isOne(raw?.selfdestruct)) hard('contract can self-destruct');
  if (isOne(raw?.gas_abuse)) hard('gas-abuse behavior detected');
  if (isOne(raw?.fake_token?.value)) hard('counterfeit token flag');
  if (isOne(raw?.is_airdrop_scam)) hard('airdrop scam flag');
  if (String(raw?.is_open_source ?? '') === '0') hard('contract source is closed; safety cannot be verified');

  if (isOne(raw?.is_mintable)) warn(2, 'owner-controlled minting may increase supply');
  if (isOne(raw?.can_take_back_ownership)) warn(2, 'ownership can be reclaimed');
  if (isOne(raw?.is_proxy)) warn(1, 'upgradeable proxy contract');
  if (isOne(raw?.slippage_modifiable)) warn(2, 'owner can change trading tax');
  if (isOne(raw?.personal_slippage_modifiable)) warn(2, 'owner can set address-specific tax');
  if (isOne(raw?.transfer_pausable)) warn(2, 'owner can pause transfers');
  if (isOne(raw?.is_blacklisted)) warn(2, 'blacklist capability exists');
  if (isOne(raw?.anti_whale_modifiable)) warn(1, 'owner can change wallet/transaction limits');
  if (sellTax !== null && sellTax >= 0.05 && sellTax < 0.15) warn(2, `sell tax ${(sellTax * 100).toFixed(1)}%`);
  if (buyTax !== null && buyTax >= 0.05) warn(1, `buy tax ${(buyTax * 100).toFixed(1)}%`);
  if (ownerPercent >= 0.10) warn(2, `owner holds ${(ownerPercent * 100).toFixed(0)}%`);
  if (creatorPercent >= 0.10) warn(2, `creator holds ${(creatorPercent * 100).toFixed(0)}%`);
  if (holders.top >= 0.30) warn(2, `largest unlabelled unlocked holder ${(holders.top * 100).toFixed(0)}%`);
  else if (holders.top10 >= 0.65) warn(1, `top unlabelled unlocked holders ${(holders.top10 * 100).toFixed(0)}%`);
  if (lpRows.length && unlockedLp >= 0.50) warn(2, `${(unlockedLp * 100).toFixed(0)}% of visible LP is unlocked/unlabelled`);
  if (!lpRows.length) warn(1, 'LP lock coverage unavailable');
  if (raw?.other_potential_risks) warn(1, String(raw.other_potential_risks).slice(0, 140));

  return finish({
    critical,
    warnings,
    metrics: {
      holderCount: number(raw?.holder_count),
      topHolderPct: holders.top * 100,
      top10Pct: holders.top10 * 100,
      unlockedLpPct: unlockedLp * 100,
      buyTaxPct: buyTax === null ? null : buyTax * 100,
      sellTaxPct: sellTax === null ? null : sellTax * 100,
    },
    raw,
  });
};

export const assessSolanaToken = raw => {
  const critical = [];
  const warnings = [];
  const warn = (points, text) => warnings.push({ points, text });
  const hard = text => critical.push(text);
  const holders = concentration(raw?.holders);

  if (statusOne(raw?.mintable)) hard('mint authority is active');
  if (statusOne(raw?.freezable)) hard('freeze authority is active');
  if (statusOne(raw?.balance_mutable_authority)) hard('authority can mutate balances');
  if (statusOne(raw?.closable)) hard('token accounts can be forcibly closed');
  if (isOne(raw?.non_transferable)) hard('token is non-transferable');
  if (statusOne(raw?.transfer_fee_upgradable)) warn(2, 'transfer fee can be upgraded');
  if (statusOne(raw?.transfer_hook_upgradable)) warn(2, 'transfer hook can be upgraded');
  if (statusOne(raw?.default_account_state_upgradable)) warn(2, 'default account state is upgradeable');
  if (statusOne(raw?.metadata_mutable)) warn(1, 'metadata is mutable');
  if (holders.top >= 0.30) warn(2, `largest unlocked holder ${(holders.top * 100).toFixed(0)}%`);
  else if (holders.top10 >= 0.65) warn(1, `top unlocked holders ${(holders.top10 * 100).toFixed(0)}%`);
  if (!Array.isArray(raw?.lp_holders) || !raw.lp_holders.length) warn(1, 'LP lock coverage unavailable');

  return finish({
    critical,
    warnings,
    metrics: {
      holderCount: number(raw?.holder_count),
      topHolderPct: holders.top * 100,
      top10Pct: holders.top10 * 100,
    },
    raw,
  });
};

export const assessSuiToken = raw => {
  const critical = [];
  const warnings = [];
  const warn = (points, text) => warnings.push({ points, text });
  const holders = concentration(raw?.holders);
  if (statusOne(raw?.mintable)) critical.push('mint capability is active');
  if (statusOne(raw?.blacklist)) critical.push('blacklist capability is active');
  if (statusOne(raw?.contract_upgradeable)) warn(2, 'contract is upgradeable');
  if (statusOne(raw?.metadata_modifiable)) warn(1, 'metadata is modifiable');
  if (holders.top >= 0.30) warn(2, `largest holder ${(holders.top * 100).toFixed(0)}%`);
  else if (holders.top10 >= 0.65) warn(1, `top holders ${(holders.top10 * 100).toFixed(0)}%`);
  return finish({
    critical,
    warnings,
    metrics: {
      holderCount: number(raw?.holder_count),
      topHolderPct: holders.top * 100,
      top10Pct: holders.top10 * 100,
    },
    raw,
  });
};

const endpointFor = (token, base) => {
  const chain = String(token.chainName ?? '').toLowerCase();
  if (chain === 'solana') return `${base}/api/v1/solana/token_security`;
  if (chain === 'sui') return `${base}/api/v1/sui/token_security`;
  if (chain === 'tron') return `${base}/api/v1/token_security/tron`;
  if (/^\d+$/.test(String(token.chainId))) return `${base}/api/v1/token_security/${token.chainId}`;
  return null;
};

export const fetchAndAssessOnchain = async (token, cfg) => {
  const endpoint = endpointFor(token, cfg.onchainRiskApiUrl);
  if (!endpoint) {
    return finish({
      coverage: 'UNSUPPORTED',
      critical: ['on-chain security coverage unavailable for this chain'],
      warnings: [],
      metrics: {},
      raw: null,
    });
  }
  const headers = cfg.onchainRiskApiToken ? { authorization: `Bearer ${cfg.onchainRiskApiToken}` } : {};
  const url = `${endpoint}?${new URLSearchParams({ contract_addresses: token.contractAddress })}`;
  const response = await requestJson(url, { headers, timeoutMs: 15_000, retries: 1 });
  if (Number(response?.code) !== 1 || !response?.result || typeof response.result !== 'object') {
    throw new Error(`on-chain provider returned no usable result (${response?.message ?? 'unknown'})`);
  }
  // v6.9.9 FIX: the previous fallback to Object.values(response.result)[0]
  // could silently hand back a DIFFERENT token's security record if neither
  // the exact nor lowercased address matched — presenting another contract's
  // honeypot/mint/tax data as this token's screen with no indication of the
  // mismatch. That is worse than no data: a false "safe" on the wrong token.
  // Now an unmatched address is a hard error, never a guess.
  const exact = response.result[token.contractAddress]
    ?? response.result[String(token.contractAddress).toLowerCase()];
  if (!exact || typeof exact !== 'object') {
    throw new Error(`on-chain provider returned no record for ${token.contractAddress} (received ${Object.keys(response.result).length} unrelated record(s))`);
  }
  const chain = String(token.chainName ?? '').toLowerCase();
  if (chain === 'solana') return assessSolanaToken(exact);
  if (chain === 'sui') return assessSuiToken(exact);
  return assessEvmToken(exact);
};


