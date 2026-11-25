/**
 * Pedidos a Supabase con un reintento (mismo criterio que Rootsy, 2026-11-18/20):
 * - Lecturas (GET/HEAD y RPC que solo leen): si pasan 5 s se cortan y se piden una vez
 *   más; también ante un corte del borde (5xx de red). Leer dos veces no cambia nada.
 * - Escrituras: solo ante 522/523, que dicen que el pedido nunca llegó a la base. Un 502,
 *   503 o 524 pudo haber escrito: eso lo resuelve la clave única de cada escritura
 *   (idempotencia), no un reintento a ciegas. A una escritura no se le corta la espera.
 */
const CORTE_DE_LECTURA = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const NO_LLEGO = new Set([522, 523]);
const ESPERA_MS = 250;
const TOPE_DE_LECTURA_MS = 5_000;
const TOPE_DEL_REINTENTO_MS = 8_000;

/** Funciones de la base que solo leen. Una nueva que solo lee se suma acá; si no está, se trata como escritura. */
const RPC_DE_LECTURA = new Set(["latest_progress_entries"]);

function urlDe(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

export function esLectura(input: RequestInfo | URL, metodo: string) {
  if (metodo === "GET" || metodo === "HEAD") return true;
  if (metodo !== "POST") return false;
  const rpc = /\/rest\/v1\/rpc\/([a-z_0-9]+)/.exec(urlDe(input))?.[1];
  return rpc !== undefined && RPC_DE_LECTURA.has(rpc);
}

async function conTope(input: RequestInfo | URL, init: RequestInit | undefined, ms: number) {
  const corte = new AbortController();
  const reloj = setTimeout(() => corte.abort(new DOMException("La base no contestó a tiempo.", "TimeoutError")), ms);
  const signal = init?.signal ? AbortSignal.any([init.signal, corte.signal]) : corte.signal;
  try {
    return await fetch(input, { ...init, signal });
  } finally {
    clearTimeout(reloj);
  }
}

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchConReintento(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const metodo = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const lectura = esLectura(input, metodo);
  try {
    const respuesta = lectura ? await conTope(input, init, TOPE_DE_LECTURA_MS) : await fetch(input, init);
    if (!(lectura ? CORTE_DE_LECTURA : NO_LLEGO).has(respuesta.status)) return respuesta;
  } catch (error) {
    // Una escritura que falló por red pudo haber llegado: no se repite.
    if (!lectura || init?.signal?.aborted) throw error;
  }
  await esperar(ESPERA_MS);
  return lectura ? conTope(input, init, TOPE_DEL_REINTENTO_MS) : fetch(input, init);
}
