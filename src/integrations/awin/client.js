const zlib = require('zlib');
const { Readable } = require('stream');
const { StringDecoder } = require('string_decoder');

// Awin = rede de afiliados da Riachuelo. Três peças, como na Netshoes/Rakuten:
//  1) Publisher API (api.awin.com, token Bearer): ofertas/cupons (Offers API) e link curto (Link Builder API);
//  2) Product Feed (productdata.awin.com, chave PRÓPRIA do feed): catálogo com preço atual e preço "de";
//  3) Link de afiliado montado localmente com o Publisher ID + Advertiser ID (sem gastar chamada de API).
// Limite da Awin: 20 chamadas por minuto na Publisher API — por isso a busca usa o feed (1 download) e
// só 1-2 chamadas de API por busca.
const API_BASE = 'https://api.awin.com';
const FEED_LIST_URL = 'https://productdata.awin.com/datafeed/list/apikey';
const REQUEST_TIMEOUT_MS = 12000;
const FEED_TIMEOUT_MS = 40000;

function authHeaders(token) {
  return { Authorization: `Bearer ${String(token || '').trim()}`, 'Content-Type': 'application/json' };
}

async function apiRequest(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: authHeaders(token),
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* resposta não-JSON */ }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (token inválido ou expirado — gere outro em Awin > API Credentials)'
      : res.status === 403 ? ' (sem permissão: confira se o token é da mesma conta/Publisher ID)'
      : res.status === 429 ? ' (limite de 20 chamadas por minuto da Awin — espere 1 minuto)' : '';
    throw new Error(`Awin respondeu ${res.status}${hint}: ${String((data && (data.description || data.message || data.error)) || text).slice(0, 300)}`);
  }
  return data;
}

// ---------- Programas (para achar o Advertiser ID da Riachuelo) ----------
async function listJoinedProgrammes(publisherId, token) {
  const data = await apiRequest('GET', `/publishers/${encodeURIComponent(publisherId)}/programmes?relationship=joined`, token);
  return Array.isArray(data) ? data : [];
}

async function findAdvertiserId(publisherId, token, nameHint) {
  const list = await listJoinedProgrammes(publisherId, token);
  const hint = String(nameHint || '').toLowerCase();
  const hit = list.find((p) => String(p.name || '').toLowerCase().includes(hint));
  return hit ? { id: String(hit.id), name: hit.name } : null;
}

// ---------- Ofertas e cupons (Offers API) ----------
// Devolve cupons/ofertas ativos do anunciante já no formato interno usado pela tela e pelo disparador
// (mesmo formato dos cupons da Netshoes: code, description, restriction, endsAt, clickUrl).
async function fetchOffers(publisherId, token, advertiserId, { pageSize = 200, maxPages = 3 } = {}) {
  const out = [];
  let total = null;
  for (let page = 1; page <= maxPages; page += 1) {
    const data = await apiRequest('POST', `/publisher/${encodeURIComponent(publisherId)}/promotions`, token, {
      filters: { advertiserIds: [Number(advertiserId)], membership: 'joined', status: 'active', type: 'all', regionCodes: ['BR'] },
      pagination: { page, pageSize },
    });
    const rows = Array.isArray(data) ? data : (data && (data.data || data.promotions || data.offers)) || [];
    if (data && data.pagination && data.pagination.total != null) total = data.pagination.total;
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  const offers = out.map((o) => ({
    id: String(o.promotionId || ''),
    type: o.type || (o.voucher ? 'voucher' : 'promotion'),
    code: (o.voucher && o.voucher.code) ? String(o.voucher.code).trim() : null,
    description: [o.title, o.description].filter(Boolean).join(' — '),
    restriction: o.terms ? String(o.terms).replace(/\s+/g, ' ').trim().slice(0, 600) : null,
    startsAt: o.startDate || null,
    endsAt: o.endDate || null,
    clickUrl: o.urlTracking || o.url || null,
    categories: [],
    exclusive: Boolean(o.voucher && o.voucher.exclusive),
  }));
  offers.totalMatches = total != null ? total : offers.length;
  return offers;
}

// ---------- Link de afiliado ----------
// Link longo montado localmente (formato oficial de deeplink da Awin).
function buildAffiliateLink(publisherId, advertiserId, targetUrl) {
  return `https://www.awin1.com/cread.php?awinmid=${encodeURIComponent(advertiserId)}&awinaffid=${encodeURIComponent(publisherId)}&ued=${encodeURIComponent(targetUrl)}`;
}

// Link curto (tidd.ly) pela Link Builder API. Se a Awin recusar, quem chama usa o link longo.
async function generateShortLink(publisherId, token, advertiserId, destinationUrl, clickref) {
  const data = await apiRequest('POST', `/publishers/${encodeURIComponent(publisherId)}/linkbuilder/generate`, token, {
    advertiserId: Number(advertiserId),
    destinationUrl,
    shorten: true,
    ...(clickref ? { parameters: { clickref: String(clickref).slice(0, 50) } } : {}),
  });
  return { url: (data && data.url) || null, shortUrl: (data && data.shortUrl) || null };
}

// ---------- CSV em fluxo (o feed pode ter centenas de milhares de linhas) ----------
function createCsvParser(onRow) {
  let field = '';
  let row = [];
  let inQuotes = false;
  let pendingQuote = false; // viu uma aspa dentro de campo entre aspas: pode ser fim ou aspa escapada
  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); if (!(row.length === 1 && row[0] === '')) onRow(row); row = []; };

  return {
    write(text) {
      for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        if (pendingQuote) {
          pendingQuote = false;
          if (ch === '"') { field += '"'; continue; }
          inQuotes = false; // era o fim do campo; trata este caractere abaixo
        }
        if (inQuotes) {
          if (ch === '"') pendingQuote = true; else field += ch;
        } else if (ch === '"' && field === '') {
          inQuotes = true;
        } else if (ch === ',') {
          endField();
        } else if (ch === '\n') {
          endRow();
        } else if (ch !== '\r') {
          field += ch;
        }
      }
    },
    end() { if (pendingQuote) { inQuotes = false; } if (field !== '' || row.length) endRow(); },
  };
}

function normHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// ---------- Feed de produtos ----------
// Acha, na lista de feeds da sua conta, o feed do anunciante (já com a URL de download completa).
async function resolveFeed(feedKey, { advertiserId, feedId, nameHint } = {}) {
  // Aceita as duas formas: o endereço inteiro do quadro "Feed List Download" (formato novo da Awin,
  // ex: https://ui.awin.com/productdata-darwin-download/publisher/123/CHAVE/57/feedList)
  // ou só a chave do formato antigo (productdata.awin.com/datafeed/list/apikey/CHAVE).
  const keyOrUrl = String(feedKey).trim();
  const listUrl = /^https?:\/\//i.test(keyOrUrl) ? keyOrUrl : `${FEED_LIST_URL}/${encodeURIComponent(keyOrUrl)}`;
  const res = await fetch(listUrl, { redirect: 'follow', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  if (!res.ok || /^\s*</.test(text)) {
    throw new Error(`A Awin não aceitou o endereço/chave do feed (${res.status}): ${text.slice(0, 200)}. Cole o endereço inteiro do quadro "Feed List Download" em Awin > Toolbox > Create-a-Feed (não é o token da API).`);
  }
  let rows = [];
  if (/^\s*[\[{]/.test(text)) {
    // Algumas versões devolvem JSON em vez de CSV.
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    const list = Array.isArray(json) ? json : (json && (json.feeds || json.data || json.items)) || [];
    if (list.length) {
      const keys = Object.keys(list[0]);
      rows = [keys, ...list.map((o) => keys.map((k) => (o[k] == null ? '' : String(o[k]))))];
    }
  } else {
    const parser = createCsvParser((r) => rows.push(r));
    parser.write(text); parser.end();
  }
  if (rows.length < 2) throw new Error(`A lista de feeds da Awin veio vazia (você já foi aprovado na Riachuelo?). Resposta: ${text.slice(0, 200)}`);

  const header = rows[0].map(normHeader);
  const col = (name) => header.indexOf(name);
  const iAdv = col('advertiserid'); const iName = col('advertisername'); const iFeed = col('feedid');
  const iMember = col('membershipstatus'); const iLang = col('language'); const iUrl = col('url');
  const iImported = col('lastimported'); const iRegion = col('primaryregion');
  if (iUrl < 0 || iAdv < 0) throw new Error(`Formato inesperado da lista de feeds da Awin (colunas recebidas: ${rows[0].join(', ').slice(0, 300)}). Me mande essa mensagem que eu ajusto.`);

  const hint = String(nameHint || '').toLowerCase();
  let cand = rows.slice(1).filter((r) => {
    if (advertiserId) return String(r[iAdv]).trim() === String(advertiserId).trim();
    return hint && String(r[iName] || '').toLowerCase().includes(hint);
  });
  if (feedId) cand = cand.filter((r) => String(r[iFeed]).trim() === String(feedId).trim());
  if (!cand.length) {
    const names = [...new Set(rows.slice(1).map((r) => r[iName]).filter(Boolean))].slice(0, 8).join(', ');
    throw new Error(`Não achei feed da Riachuelo na lista da sua conta da Awin${advertiserId ? ` (Advertiser ID ${advertiserId})` : ''}. Anunciantes com feed na sua conta: ${names || 'nenhum'}. Se a Riachuelo não está aí, ela não oferece feed de produtos para você (ou a afiliação não foi aprovada).`);
  }

  const score = (r) => (/joined|active/i.test(r[iMember] || '') ? 4 : 0) + (/^pt/i.test(r[iLang] || '') ? 2 : 0) + (/BR/i.test(r[iRegion] || '') ? 1 : 0);
  cand.sort((a, b) => score(b) - score(a));
  const best = cand[0];
  let url = String(best[iUrl] || '').trim();
  if (!url) throw new Error('O feed da Riachuelo está na lista, mas sem URL de download (talvez você ainda não tenha sido aprovado).');
  // Pede o arquivo compactado (mais rápido e conta menos tráfego).
  if (!/\/compression\//i.test(url)) url = url.replace(/\/?$/, '/') + 'compression/gzip/';
  return {
    url,
    feedId: String(best[iFeed] || ''),
    advertiserId: String(best[iAdv] || ''),
    name: best[iName] || '',
    lastImported: iImported >= 0 ? best[iImported] : null,
    membership: iMember >= 0 ? best[iMember] : null,
  };
}

// Baixa o feed e entrega cada produto (objeto com os nomes de coluna da Awin) para onRow.
// onRow devolve true para parar antes (quando já tem produto suficiente).
async function streamFeed(feedUrl, onProduct) {
  const res = await fetch(feedUrl, { signal: AbortSignal.timeout(FEED_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`A Awin recusou o download do feed (${res.status}). Limite: 5 downloads iguais por hora.`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 200 && /^\s*(<|error|invalid)/i.test(buf.toString('utf8'))) {
    throw new Error(`A Awin respondeu ao download do feed com: ${buf.toString('utf8').slice(0, 200)}`);
  }
  const isGzip = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const source = isGzip ? Readable.from([buf]).pipe(zlib.createGunzip()) : Readable.from([buf]);
  const decoder = new StringDecoder('utf8');

  let header = null;
  let rowsRead = 0;
  let stop = false;
  const parser = createCsvParser((r) => {
    if (stop) return;
    if (!header) { header = r.map((h) => String(h).trim().toLowerCase()); return; }
    rowsRead += 1;
    const obj = {};
    for (let i = 0; i < header.length; i += 1) obj[header[i]] = r[i];
    if (onProduct(obj) === true) stop = true;
  });

  for await (const chunk of source) {
    parser.write(decoder.write(chunk));
    if (stop) { source.destroy(); break; }
  }
  if (!stop) { parser.write(decoder.end()); parser.end(); }
  return { rowsRead, columns: header || [], bytes: buf.length };
}

module.exports = {
  listJoinedProgrammes,
  findAdvertiserId,
  fetchOffers,
  buildAffiliateLink,
  generateShortLink,
  resolveFeed,
  streamFeed,
  createCsvParser,
};
