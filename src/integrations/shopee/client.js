const crypto = require('crypto');

const GRAPHQL_URL = 'https://open-api.affiliate.shopee.com.br/graphql';

/**
 * Monta o header de autenticação exigido pela Shopee Affiliate Open API.
 * Doc oficial: help.shopee.sg/portal/10/article/191702-API-Access
 * Formato: SHA256 Credential={AppId}, Timestamp={Timestamp}, Signature={Signature}
 * Signature = SHA256(AppId + Timestamp + Payload + Secret), hex, minúsculo.
 */
function buildAuthHeader(appId, appSecret, payload) {
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = `${appId}${timestamp}${payload}${appSecret}`;
  const signature = crypto.createHash('sha256').update(raw).digest('hex');
  return {
    header: `SHA256 Credential=${appId}, Timestamp=${timestamp}, Signature=${signature}`,
    timestamp,
  };
}

async function graphqlRequest(appId, appSecret, query, variables) {
  const payload = JSON.stringify({ query, variables });
  const { header } = buildAuthHeader(appId, appSecret, payload);

  const res = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: header,
    },
    body: payload,
  });

  const data = await res.json();
  if (!res.ok || data.errors) {
    throw new Error(`Shopee GraphQL falhou: ${JSON.stringify(data.errors || data)}`);
  }
  return data.data;
}

/**
 * Busca ofertas de produto por palavra-chave.
 * ATENÇÃO: os nomes de campo abaixo (itemId, productName, priceMin, priceDiscountRate,
 * commissionRate, offerLink, imageUrl) vêm de integrações de terceiros que já usam essa
 * API — a Shopee não publica o schema GraphQL completo. Assim que as credenciais forem
 * aprovadas, rode uma query de introspecção (`{ __schema { types { name } } }`) ou teste
 * uma chamada real e confirme se os nomes batem; ajuste aqui se vier diferente.
 *
 * sortType — a API aceita: 1 relevância · 2 mais vendidos · 3 preço (maior→menor)
 * · 4 preço (menor→maior) · 5 maior comissão (padrão da API se não informado).
 * Usamos 2 (mais vendidos) de propósito: ordenar por comissão tende a devolver
 * sempre o mesmo pequeno grupo de produtos (comissão não muda a cada busca) e
 * não tem nenhuma relação com desconto. NÃO EXISTE na API um sortType de
 * "maior desconto" nem um sinal de "promoção ativa agora" — o campo
 * priceDiscountRate é só a diferença entre o preço de tabela e o de venda
 * daquele anúncio, não uma oferta relâmpago com prazo. Isso é um limite real
 * da API pública de afiliados, não algo que dá pra contornar aqui.
 */
async function searchProductOffers(appId, appSecret, keyword, { page = 1, limit = 40, sortType = 2 } = {}) {
  const query = `
    query ProductOfferQuery($keyword: String, $page: Int, $limit: Int, $sortType: Int) {
      productOfferV2(keyword: $keyword, page: $page, limit: $limit, sortType: $sortType) {
        nodes {
          itemId
          productName
          priceMin
          priceMax
          priceDiscountRate
          commissionRate
          imageUrl
          offerLink
          productLink
        }
      }
    }
  `;
  const data = await graphqlRequest(appId, appSecret, query, { keyword, page, limit, sortType });
  return data?.productOfferV2?.nodes || [];
}

/**
 * Gera o link de afiliado (curto) a partir do link original do produto.
 * subId é opcional — útil pra rastrear de qual grupo/campanha veio o clique.
 */
async function generateShortLink(appId, appSecret, originUrl, subId) {
  const query = `
    mutation GenerateShortLink($input: ShortLinkInput!) {
      generateShortLink(input: $input) {
        shortLink
      }
    }
  `;
  const variables = {
    input: {
      originUrl,
      subIds: subId ? [subId] : [],
    },
  };
  const data = await graphqlRequest(appId, appSecret, query, variables);
  return data?.generateShortLink?.shortLink || null;
}

module.exports = {
  searchProductOffers,
  generateShortLink,
};
