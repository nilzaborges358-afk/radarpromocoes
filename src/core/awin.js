const awinClient = require('../integrations/awin/client');

// Contexto e cupons da Awin (Riachuelo). Mesmo papel do getNetshoesContext / loadNetshoesCoupons.
//
// Como as credenciais ficam gravadas em marketplace_credentials (marketplace "riachuelo"):
//   client_id        = Publisher ID da Awin
//   client_secret    = Token da API (OAuth2) da Awin
//   extra_credential = Advertiser ID da Riachuelo (se vazio, o sistema descobre sozinho)
//   extra_credential_2 = Feed ID (opcional; se vazio, o sistema escolhe o feed da Riachuelo)
//   extra_credential_3 = Chave do feed de produtos (Create-a-Feed)

function todayBR() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

function isExpired(endsAt) {
  if (!endsAt) return false;
  const day = String(endsAt).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day < todayBR();
}

async function getAwinContext(supabase, { needFeed = false } = {}) {
  const { data: mp } = await supabase.from('marketplaces').select('id').eq('slug', 'riachuelo').maybeSingle();
  if (!mp) return { error: 'Marketplace Riachuelo não encontrado no banco. Rode o arquivo 0005_riachuelo_marketplace.sql no Supabase.' };

  const { data: creds } = await supabase
    .from('marketplace_credentials')
    .select('client_id, client_secret, extra_credential, extra_credential_2, extra_credential_3')
    .eq('marketplace_id', mp.id)
    .maybeSingle();

  if (!creds?.client_id || !creds?.client_secret) return { error: 'Credenciais da Riachuelo/Awin incompletas (Publisher ID e Token da API). Vá em /marketplaces.html.' };
  if (needFeed && !creds.extra_credential_3) return { error: 'Falta a Chave do Feed de produtos da Awin (Awin > Toolbox > Create-a-Feed). Cole em /marketplaces.html.' };

  let advertiserId = creds.extra_credential ? String(creds.extra_credential).trim() : null;
  let advertiserNote = null;
  if (!advertiserId) {
    try {
      const found = await awinClient.findAdvertiserId(creds.client_id, creds.client_secret, 'riachuelo');
      if (found) {
        advertiserId = found.id;
        await supabase.from('marketplace_credentials').update({ extra_credential: advertiserId }).eq('marketplace_id', mp.id);
      } else {
        return { error: 'Não achei a Riachuelo entre os programas em que você foi aprovado na Awin. Confira se a afiliação foi aprovada ou preencha o Advertiser ID em /marketplaces.html.' };
      }
    } catch (err) {
      return { error: `Não consegui descobrir o Advertiser ID da Riachuelo (${err.message}). Preencha o Advertiser ID em /marketplaces.html.` };
    }
  }

  return {
    marketplaceId: mp.id,
    publisherId: String(creds.client_id).trim(),
    token: String(creds.client_secret).trim(),
    advertiserId,
    feedId: creds.extra_credential_2 ? String(creds.extra_credential_2).trim() : null,
    feedKey: creds.extra_credential_3 ? String(creds.extra_credential_3).trim() : null,
    advertiserNote,
  };
}

// Cupons e ofertas ativos da Riachuelo, já com o desconto lido do texto (como na Netshoes).
async function loadAwinCoupons(ctx) {
  const { parseDiscountText } = require('./coupons'); // carregado aqui dentro para não criar dependência circular
  let offers;
  try {
    offers = await awinClient.fetchOffers(ctx.publisherId, ctx.token, ctx.advertiserId);
  } catch (err) {
    return { error: `Não consegui buscar os cupons na Awin: ${err.message}` };
  }

  const seen = new Set();
  const coupons = [];
  let expired = 0;
  for (const c of offers) {
    if (isExpired(c.endsAt)) { expired += 1; continue; }
    const key = `${c.id}|${c.code || ''}|${c.description || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    coupons.push({ ...c, parsed: parseDiscountText(c.description, c.restriction) });
  }
  coupons.sort((a, b) => (b.code ? 1 : 0) - (a.code ? 1 : 0) || String(a.endsAt || '9999').localeCompare(String(b.endsAt || '9999')));
  return { coupons, expired, totalMatches: offers.totalMatches };
}

// Melhor cupom (com código e sem conflito de restrição) para um produto da Riachuelo.
// Usado pelo disparador na hora de montar a mensagem — igual ao da Netshoes.
async function awinCouponForProduct(supabase, product) {
  const { bestNetshoesCoupon } = require('./coupons');
  const ctx = await getAwinContext(supabase);
  if (ctx.error) return null;
  const loaded = await loadAwinCoupons(ctx);
  if (loaded.error) return null;
  const best = bestNetshoesCoupon(loaded.coupons.filter((c) => c.code), product);
  if (!best) return null;
  return {
    code: best.coupon.code,
    description: best.coupon.description,
    restriction: best.coupon.restriction,
    endsAt: best.coupon.endsAt,
    clickUrl: best.coupon.clickUrl,
    discount: best.discount,
    finalPrice: best.finalPrice,
  };
}

module.exports = { getAwinContext, loadAwinCoupons, awinCouponForProduct, isExpired };
