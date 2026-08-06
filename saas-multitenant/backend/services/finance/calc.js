// =============================================================================
// calc.js — Regras financeiras PURAS (sem I/O, sem banco). 100% testável.
//
// Todo o dinheiro é manipulado internamente em CENTAVOS (inteiros) para evitar
// erros de ponto flutuante. As funções aceitam number|string|null e devolvem
// numbers com 2 casas (prontos para gravar em NUMERIC(15,2)).
// =============================================================================

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

// ── Dinheiro ────────────────────────────────────────────────────────────────

// Converte um valor monetário (number|string) para centavos inteiros.
// Aceita "1.234,56", "1234.56", 1234.56, "10", null → 0. Trata sinal negativo.
function toCents(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError('Valor monetário inválido');
    return Math.round(value * 100);
  }
  let s = String(value).trim();
  if (!s) return 0;
  const negative = /^-/.test(s);
  s = s.replace(/[^\d.,-]/g, '').replace(/-/g, '');
  // Se tem vírgula e ponto, o último separador é o decimal.
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');       // formato pt-BR: 1.234,56
    } else {
      s = s.replace(/,/g, '');                           // formato en: 1,234.56
    }
  } else if (s.includes(',')) {
    s = s.replace(',', '.');                             // 1234,56
  }
  const n = Number(s);
  if (!Number.isFinite(n)) throw new ValidationError('Valor monetário inválido');
  const cents = Math.round(n * 100);
  return negative ? -cents : cents;
}

// Converte centavos inteiros para number com 2 casas.
function fromCents(cents) {
  return Math.round(cents) / 100;
}

// Arredonda um valor monetário para 2 casas (via centavos).
function roundMoney(value) {
  return fromCents(toCents(value));
}

// Formata no padrão brasileiro: 1234.5 → "R$ 1.234,50"
function formatBRL(value) {
  const cents = toCents(value);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const cent = String(abs % 100).padStart(2, '0');
  const reaisStr = reais.toLocaleString('pt-BR');
  return `${negative ? '-' : ''}R$ ${reaisStr},${cent}`;
}

// ── Faturamento ──────────────────────────────────────────────────────────────

// final = original - desconto + acréscimo (em centavos). Pode ser negativo;
// a validação de negatividade é responsabilidade de validateBilling.
function computeFinalCents({ original = 0, discount = 0, surcharge = 0 }) {
  return toCents(original) - toCents(discount) + toCents(surcharge);
}

// saldo pendente = final - pago (em centavos).
function computeBalanceCents({ finalAmount = 0, paidAmount = 0 }) {
  return toCents(finalAmount) - toCents(paidAmount);
}

// Calcula final e saldo (numbers 2 casas) a partir dos componentes brutos.
// Valida as regras de negócio (lança ValidationError quando violadas).
function computeBilling({ original = 0, discount = 0, surcharge = 0, paid = 0, allowOverpay = false }) {
  const oc = toCents(original);
  const dc = toCents(discount);
  const sc = toCents(surcharge);
  const pc = toCents(paid);

  if (oc < 0) throw new ValidationError('Valor original não pode ser negativo');
  if (dc < 0) throw new ValidationError('Desconto não pode ser negativo');
  if (sc < 0) throw new ValidationError('Acréscimo não pode ser negativo');
  if (pc < 0) throw new ValidationError('Valor pago não pode ser negativo');

  const finalCents = oc - dc + sc;
  if (finalCents < 0) {
    throw new ValidationError('Valor final não pode ser negativo (desconto maior que o valor)');
  }
  if (pc > finalCents && !allowOverpay) {
    throw new ValidationError('Valor pago não pode ser maior que o valor final');
  }

  return {
    finalAmount: fromCents(finalCents),
    balance: fromCents(finalCents - pc),
    finalCents,
    paidCents: pc,
    balanceCents: finalCents - pc,
  };
}

// Deriva o status financeiro de um faturamento.
// Precedência: cancelado > pago > vencido > parcialmente_pago > faturado.
function deriveBillingStatus({ finalAmount = 0, paidAmount = 0, dueDate = null, canceled = false, referenceDate = null }) {
  if (canceled) return 'cancelado';
  const finalCents = toCents(finalAmount);
  const paidCents = toCents(paidAmount);

  if (finalCents > 0 && paidCents >= finalCents) return 'pago';

  const overdue = isOverdue(dueDate, referenceDate);
  if (overdue && paidCents < finalCents) return 'vencido';
  if (paidCents > 0) return 'parcialmente_pago';
  return 'faturado';
}

// ── Datas / semana ───────────────────────────────────────────────────────────

// 'YYYY-MM-DD' (componentes locais) a partir de um Date.
function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Constrói um Date no meio-dia local a partir de 'YYYY-MM-DD' ou Date
// (meio-dia evita problemas de DST ao somar dias).
function parseDateOnly(input) {
  if (input instanceof Date) return new Date(input.getFullYear(), input.getMonth(), input.getDate(), 12);
  const s = String(input).substring(0, 10);
  const [y, m, d] = s.split('-').map(Number);
  if (!y || !m || !d) return new Date(NaN);
  return new Date(y, m - 1, d, 12);
}

function addDays(input, n) {
  const dt = parseDateOnly(input);
  dt.setDate(dt.getDate() + n);
  return dt;
}

// Intervalo da semana que contém `ref`. weekStartsOn: 1 = segunda (ISO).
// Retorna strings 'YYYY-MM-DD' (start=segunda, end=domingo).
function getWeekRange(ref = new Date(), weekStartsOn = 1) {
  const d = parseDateOnly(ref);
  const day = d.getDay(); // 0=domingo..6=sábado
  const diff = (day - weekStartsOn + 7) % 7;
  const start = addDays(d, -diff);
  const end = addDays(start, 6);
  return { start: toISODate(start), end: toISODate(end) };
}

// Intervalo da semana deslocado por `offset` semanas a partir de `ref`.
function getWeekRangeByOffset(offset = 0, ref = new Date(), weekStartsOn = 1) {
  const base = addDays(ref, offset * 7);
  return getWeekRange(base, weekStartsOn);
}

// Primeiro e último dia do mês de `ref` (strings 'YYYY-MM-DD').
function getMonthRange(ref = new Date()) {
  const d = parseDateOnly(ref);
  const start = new Date(d.getFullYear(), d.getMonth(), 1, 12);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 12);
  return { start: toISODate(start), end: toISODate(end) };
}

// Está vencido? dueDate < hoje (comparação por dia).
function isOverdue(dueDate, referenceDate = null) {
  if (!dueDate) return false;
  const due = parseDateOnly(dueDate);
  if (Number.isNaN(due.getTime())) return false;
  const ref = referenceDate ? parseDateOnly(referenceDate) : parseDateOnly(new Date());
  return due.getTime() < ref.getTime();
}

// Formata 'YYYY-MM-DD' (ou Date) para 'DD/MM/AAAA'.
function formatDateBR(input) {
  if (!input) return '';
  const s = String(input).substring(0, 10);
  const [y, m, d] = s.split('-');
  if (y && m && d) return `${d}/${m}/${y}`;
  return '';
}

// ── Parcelas ─────────────────────────────────────────────────────────────────

// Divide um total (em centavos ou valor) em `n` parcelas inteiras de centavos.
// A última parcela absorve o resto para que a soma bata exatamente com o total.
function splitInstallments(total, n) {
  const count = parseInt(n, 10);
  if (!Number.isInteger(count) || count < 1) throw new ValidationError('Número de parcelas inválido');
  const totalCents = toCents(total);
  const base = Math.floor(totalCents / count);
  const parts = [];
  let acc = 0;
  for (let i = 0; i < count; i++) {
    const cents = i === count - 1 ? totalCents - acc : base;
    acc += cents;
    parts.push(fromCents(cents));
  }
  return parts;
}

// ── Recibo ───────────────────────────────────────────────────────────────────

// Formata o número do recibo: ('SISV', 1) → 'SISV-000001'
function formatReceiptNumber(prefix, n, pad = 6) {
  const p = (prefix || 'SISV').toString().trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SISV';
  const num = String(Math.max(0, parseInt(n, 10) || 0)).padStart(pad, '0');
  return `${p}-${num}`;
}

// ── Valor por extenso (pt-BR) ────────────────────────────────────────────────

const UNIDADES = ['zero','um','dois','três','quatro','cinco','seis','sete','oito','nove'];
const DEZ_A_DEZENOVE = ['dez','onze','doze','treze','quatorze','quinze','dezesseis','dezessete','dezoito','dezenove'];
const DEZENAS = ['','','vinte','trinta','quarenta','cinquenta','sessenta','setenta','oitenta','noventa'];
const CENTENAS = ['','cento','duzentos','trezentos','quatrocentos','quinhentos','seiscentos','setecentos','oitocentos','novecentos'];

function trioPorExtenso(n) {
  // n de 0 a 999
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const partes = [];
  const c = Math.floor(n / 100);
  const resto = n % 100;
  if (c > 0) partes.push(CENTENAS[c]);
  if (resto > 0) {
    if (resto < 10) partes.push(UNIDADES[resto]);
    else if (resto < 20) partes.push(DEZ_A_DEZENOVE[resto - 10]);
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u > 0 ? `${DEZENAS[d]} e ${UNIDADES[u]}` : DEZENAS[d]);
    }
  }
  return partes.join(' e ');
}

function inteiroPorExtenso(n) {
  if (n === 0) return 'zero';
  const grupos = [];         // grupos[0]=unidades, [1]=milhar, [2]=milhão, [3]=bilhão
  let resto = n;
  while (resto > 0) {
    grupos.push(resto % 1000);
    resto = Math.floor(resto / 1000);
  }
  const escSing = ['', 'mil', 'milhão', 'bilhão'];
  const escPlur = ['', 'mil', 'milhões', 'bilhões'];

  const items = []; // { idx, value, text } dos grupos não-zero, do maior para o menor
  for (let i = grupos.length - 1; i >= 0; i--) {
    const g = grupos[i];
    if (g === 0) continue;
    let text;
    if (i === 1 && g === 1) {
      text = 'mil';
    } else {
      const ext = trioPorExtenso(g);
      const esc = i > 0 ? ` ${g === 1 ? escSing[i] : escPlur[i]}` : '';
      text = `${ext}${esc}`;
    }
    items.push({ idx: i, value: g, text });
  }

  if (items.length === 1) return items[0].text;

  // Convenção pt-BR: "e" antes do último grupo somente quando ele for o grupo das
  // unidades (idx 0) e valer menos de 100 OU ser centena redonda (múltiplo de 100).
  const last = items[items.length - 1];
  const useE = last.idx === 0 && (last.value < 100 || last.value % 100 === 0);
  const head = items.slice(0, -1).map((it) => it.text).join(' ');
  return `${head}${useE ? ' e ' : ' '}${last.text}`;
}

// Converte um valor monetário para extenso em reais/centavos (pt-BR).
// 1234.56 → "mil duzentos e trinta e quatro reais e cinquenta e seis centavos"
function valorPorExtenso(value) {
  const cents = Math.abs(toCents(value));
  const reais = Math.floor(cents / 100);
  const centavos = cents % 100;

  const partes = [];
  if (reais > 0) {
    partes.push(`${inteiroPorExtenso(reais)} ${reais === 1 ? 'real' : 'reais'}`);
  }
  if (centavos > 0) {
    partes.push(`${inteiroPorExtenso(centavos)} ${centavos === 1 ? 'centavo' : 'centavos'}`);
  }
  if (partes.length === 0) return 'zero real';
  return partes.join(' e ');
}

module.exports = {
  ValidationError,
  toCents,
  fromCents,
  roundMoney,
  formatBRL,
  computeFinalCents,
  computeBalanceCents,
  computeBilling,
  deriveBillingStatus,
  toISODate,
  parseDateOnly,
  addDays,
  getWeekRange,
  getWeekRangeByOffset,
  getMonthRange,
  isOverdue,
  formatDateBR,
  splitInstallments,
  formatReceiptNumber,
  valorPorExtenso,
};
