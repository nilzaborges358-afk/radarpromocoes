// Detecção de produto repetido (mesmo produto vendido por vendedores diferentes).
//
// Por que existe: a Shopee devolve o MESMO produto em vários anúncios (um por vendedor), cada um
// com link diferente. O sistema só comparava o LINK, então o produto repetia no painel e no
// disparador. Aqui o produto é reconhecido pelo TÍTULO (palavras que importam + números como
// "300ml", "kit 4", "10 peças").
//
// Sem dependências e sem pasta nova: é só um arquivo em src/core.

const STOP = new Set([
  'de', 'da', 'do', 'das', 'dos', 'e', 'com', 'sem', 'para', 'pra', 'em', 'a', 'o', 'as', 'os', 'um', 'uma',
  'por', 'no', 'na', 'nos', 'nas', 'ou', 'ao', 'aos', 'que', 'mais', 'muito', 'super', 'ate',
  // palavras de propaganda que os vendedores enfiam no título e não identificam o produto
  'original', 'originais', 'promocao', 'oferta', 'ofertas', 'lancamento', 'novo', 'nova', 'novos', 'novas',
  'frete', 'gratis', 'envio', 'imediato', 'imediata', 'rapido', 'rapida', 'full', 'barato', 'barata',
  'qualidade', 'premium', 'top', 'melhor', 'pronta', 'pronto', 'entrega', 'brasil', 'oficial',
  'unidade', 'unidades', 'unid', 'und', 'peca', 'pecas', 'pcs', 'pc', 'par', 'pares', 'jogo',
]);

function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Quebra o título em { words, nums }.
//  words = palavras relevantes (sem acento, minúsculas, sem palavras de propaganda)
//  nums  = tokens com algum dígito (300ml, 4, 140cm, 8l) — quantidade/tamanho diferente = produto diferente
function tokenize(title) {
  const clean = stripAccents(title).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = new Set();
  const nums = new Set();
  for (const raw of clean.split(' ')) {
    if (!raw) continue;
    if (/\d/.test(raw)) {
      // separa "300ml" em 300 + ml? Não: mantém junto, mas "4x" e "x4" ficam só com o número.
      nums.add(raw.replace(/^x(?=\d)|(?<=\d)x$/g, ''));
      continue;
    }
    if (raw.length < 3 || STOP.has(raw)) continue;
    // plural simples: "esponjas" == "esponja"
    words.add(raw.length > 4 && raw.endsWith('s') ? raw.slice(0, -1) : raw);
  }
  return { words, nums };
}

function sameNums(a, b) {
  // Quantidade/tamanho tem que bater: "10 peças" não é o mesmo anúncio que o pano sem quantidade,
  // e "kit 4" não é "kit 3". Prefere deixar passar um repetido raro a esconder uma oferta diferente.
  if (a.size !== b.size) return false;
  for (const n of a) if (!b.has(n)) return false;
  return true;
}

// Dois tokenizados representam o mesmo produto?
function similarTokens(a, b) {
  if (!a.words.size || !b.words.size) return false;
  if (!sameNums(a.nums, b.nums)) return false;
  let shared = 0;
  for (const w of a.words) if (b.words.has(w)) shared += 1;
  if (!shared) return false;
  const union = a.words.size + b.words.size - shared;
  const jaccard = shared / union;
  const overlap = shared / Math.min(a.words.size, b.words.size);
  // título curto e quase igual, ou título longo que contém o outro quase inteiro
  return (shared >= 2 && jaccard >= 0.6) || (shared >= 4 && overlap >= 0.8);
}

function similarTitles(titleA, titleB) {
  return similarTokens(tokenize(titleA), tokenize(titleB));
}

// Índice para comparar um monte de itens sem refazer a tokenização toda hora.
// add(item) guarda; findSimilar(title) devolve o primeiro item parecido (ou null).
class SimilarIndex {
  constructor() {
    this.items = []; // { tok, item }
  }
  add(title, item) {
    this.items.push({ tok: tokenize(title), item });
  }
  findSimilar(title) {
    const tok = tokenize(title);
    for (const it of this.items) if (similarTokens(tok, it.tok)) return it.item;
    return null;
  }
  get size() { return this.items.length; }
}

// Carrega as promoções recentes de um marketplace (títulos) para comparar com o que a busca achou agora.
// O Supabase devolve no máximo 1000 linhas por consulta, por isso a leitura é em páginas.
async function loadRecentIndex(supabase, marketplaceId, days = 14, maxRows = 3000) {
  const index = new SimilarIndex();
  const since = new Date(Date.now() - days * 864e5).toISOString();
  for (let from = 0; from < maxRows; from += 1000) {
    const { data, error } = await supabase
      .from('promotions')
      .select('id, title, current_price, original_url')
      .eq('marketplace_id', marketplaceId)
      // inclui as IGNORADAS de propósito: se você ignorou um produto, o mesmo produto de outro vendedor não volta
      .gte('detected_at', since)
      .order('detected_at', { ascending: false })
      .range(from, from + 999);
    if (error) return { index, error: error.message };
    for (const row of data || []) index.add(row.title, row);
    if (!data || data.length < 1000) break;
  }
  return { index, error: null };
}

// Dentro de uma lista de candidatos novos, remove os repetidos e fica com o MAIS BARATO de cada produto.
// getTitle / getPrice dizem onde ler título e preço de cada item.
function keepCheapestOfEach(list, getTitle, getPrice) {
  const kept = []; // { tok, item }
  for (const item of list) {
    const tok = tokenize(getTitle(item));
    const match = kept.find((k) => similarTokens(tok, k.tok));
    if (!match) { kept.push({ tok, item }); continue; }
    if (getPrice(item) < getPrice(match.item)) match.item = item;
  }
  return kept.map((k) => k.item);
}

module.exports = { tokenize, similarTokens, similarTitles, SimilarIndex, loadRecentIndex, keepCheapestOfEach };
