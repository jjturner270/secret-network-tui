import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4173);
const LCD = process.env.SECRET_LCD || 'https://lcd.secret.mainnet.secret3.dev';

const cache = new Map();
const history = [];
let previousBlock = null;

async function cachedJson(name, url, ttlMs, {allowStale=true} = {}) {
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && now - hit.fetchedAt < ttlMs) return {...hit, state:'ok', fromCache:true};

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4500);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'accept':'application/json', 'user-agent':'secret-network-iteration/0.1' }
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    const entry = { data, fetchedAt: now, state:'ok', error:null };
    cache.set(name, entry);
    return entry;
  } catch (error) {
    if (allowStale && hit) return {...hit, state:'stale', error:String(error?.message || error)};
    return {data:null, fetchedAt:0, state:'error', error:String(error?.message || error)};
  }
}

const micro = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n / 1_000_000 : null;
};
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pick = (...vals) => vals.find(v => v !== undefined && v !== null);

function proposalTitle(p){
  const c = p?.messages?.[0]?.content || p?.content || {};
  return pick(p?.title, p?.metadata?.title, c?.title, c?.name, `Proposal ${p?.id || ''}`);
}
function proposalSummary(p){
  const c = p?.messages?.[0]?.content || p?.content || {};
  return pick(p?.summary, p?.metadata?.summary, c?.description, c?.summary, '');
}

function source(name, entry){
  const ageSec = entry?.fetchedAt ? Math.round((Date.now()-entry.fetchedAt)/1000) : null;
  return {name, state:entry?.state || 'error', age:ageSec == null ? '' : `${ageSec}s`, error:entry?.error || null};
}

async function snapshot(){
  const latestP = cachedJson('latest', `${LCD}/cosmos/base/tendermint/v1beta1/blocks/latest`, 4000);
  const poolP = cachedJson('pool', `${LCD}/cosmos/staking/v1beta1/pool`, 60000);
  const inflationP = cachedJson('inflation', `${LCD}/cosmos/mint/v1beta1/inflation`, 600000);
  const bondedValsP = cachedJson('bondedVals', `${LCD}/cosmos/staking/v1beta1/validators?status=BOND_STATUS_BONDED&pagination.limit=1&pagination.count_total=true`, 60000);
  const allValsP = cachedJson('allVals', `${LCD}/cosmos/staking/v1beta1/validators?pagination.limit=1&pagination.count_total=true`, 60000);
  const proposalsP = cachedJson('proposals', `${LCD}/cosmos/gov/v1/proposals?pagination.limit=5&pagination.reverse=true&proposal_status=2`, 60000);

  const [latest, pool, inflation, bondedVals, allVals, proposals] = await Promise.all([
    latestP, poolP, inflationP, bondedValsP, allValsP, proposalsP
  ]);

  const block = latest.data?.block;
  const blockId = latest.data?.block_id;
  const height = num(block?.header?.height);
  const time = block?.header?.time || null;
  const hash = blockId?.hash || '';

  let txEntry = {data:null, fetchedAt:0, state:'error', error:'block unavailable'};
  let txCount = null;
  if (height != null) {
    txEntry = await cachedJson(
      `tx-${height}`,
      `${LCD}/cosmos/tx/v1beta1/txs?query=${encodeURIComponent(`tx.height=${height}`)}&order_by=ORDER_BY_DESC&pagination.limit=100&pagination.offset=0`,
      3600000
    );
    txCount = Array.isArray(txEntry.data?.tx_responses) ? txEntry.data.tx_responses.length :
              num(txEntry.data?.pagination?.total);
  }

  if (height != null && (!history.length || history[0].height !== height)) {
    history.unshift({height,time,hash,txCount});
    if (history.length > 12) history.length = 12;
  } else if (history[0] && history[0].height === height && txCount != null) {
    history[0].txCount = txCount;
  }

  let observedBlockTime = null;
  if (history.length >= 2) {
    const diffs = [];
    for (let i=0;i<history.length-1;i++){
      const a = new Date(history[i].time).getTime();
      const b = new Date(history[i+1].time).getTime();
      const dh = history[i].height - history[i+1].height;
      if (Number.isFinite(a) && Number.isFinite(b) && dh > 0) diffs.push((a-b)/1000/dh);
    }
    if (diffs.length) observedBlockTime = diffs.reduce((a,b)=>a+b,0)/diffs.length;
  }

  const bondedTokens = num(pool.data?.pool?.bonded_tokens);
  const notBondedTokens = num(pool.data?.pool?.not_bonded_tokens);
  const stakingTotal = bondedTokens != null && notBondedTokens != null ? bondedTokens + notBondedTokens : null;

  const proposalList = Array.isArray(proposals.data?.proposals) ? proposals.data.proposals.map(p => ({
    id: p.id,
    title: proposalTitle(p),
    summary: proposalSummary(p),
    votingEnd: p.voting_end_time || null
  })) : [];

  return {
    generatedAt: new Date().toISOString(),
    block: {height,time,hash},
    observedBlockTime,
    txCount,
    blocks: history,
    validators: {
      bonded: num(bondedVals.data?.pagination?.total) ?? (Array.isArray(bondedVals.data?.validators) ? bondedVals.data.validators.length : null),
      total: num(allVals.data?.pagination?.total) ?? (Array.isArray(allVals.data?.validators) ? allVals.data.validators.length : null)
    },
    staking: {
      bondedScrt: micro(bondedTokens),
      notBondedScrt: micro(notBondedTokens),
      bondedRatio: stakingTotal ? bondedTokens / stakingTotal : null
    },
    inflation: num(inflation.data?.inflation),
    proposals: proposalList,
    sources: [
      source('latest block', latest),
      source('block transactions', txEntry),
      source('staking pool', pool),
      source('bonded validators', bondedVals),
      source('validator registry', allVals),
      source('inflation', inflation),
      source('governance', proposals)
    ]
  };
}

const server = http.createServer(async (req,res) => {
  try {
    if (req.url === '/api/snapshot') {
      const data = await snapshot();
      res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify(data));
    }
    if (req.url === '/' || req.url === '/index.html') {
      const html = await readFile(join(__dirname,'index.html'));
      res.writeHead(200, {'content-type':'text/html; charset=utf-8'});
      return res.end(html);
    }
    if (req.url === '/health') {
      res.writeHead(200, {'content-type':'application/json'});
      return res.end(JSON.stringify({ok:true}));
    }
    res.writeHead(404, {'content-type':'text/plain; charset=utf-8'});
    res.end('not found');
  } catch (error) {
    res.writeHead(500, {'content-type':'application/json; charset=utf-8'});
    res.end(JSON.stringify({error:String(error?.message || error)}));
  }
});

server.listen(PORT,'0.0.0.0',()=>{
  console.log(`Secret Network iteration: http://0.0.0.0:${PORT}`);
  console.log(`LCD: ${LCD}`);
});
