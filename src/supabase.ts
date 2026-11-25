import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Entorno } from "./entorno";
import { ApiError, sinSesion } from "./error";
import { fetchConReintento } from "./reintento";

const opciones = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: fetchConReintento },
} as const;

/**
 * Cliente con el token de la persona: la base aplica la RLS por rol en cada consulta.
 * Es el camino normal de toda lectura y escritura.
 */
export function clienteDePersona(env: Entorno, token: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    ...opciones,
    global: { ...opciones.global, headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Saltea la RLS. Solo para datos que la RLS no da y la pantalla necesita (p. ej. nombres del equipo). */
export function clienteDeServicio(env: Entorno): SupabaseClient {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new ApiError(500, "config", "Falta la configuración del servidor.");
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, opciones);
}

export type Sesion = { userId: string; email: string | null; token: string };

export function tokenDe(request: Request): string | null {
  const valor = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(valor);
  return match?.[1]?.trim() || null;
}

/** Valida el token (firma y vencimiento) sin un viaje extra a Auth cuando las claves son asimétricas. */
export async function sesionDe(env: Entorno, request: Request): Promise<Sesion> {
  const token = tokenDe(request);
  if (!token) throw sinSesion();
  const cliente = clienteDePersona(env, token);
  const { data, error } = await cliente.auth.getClaims(token);
  const claims = data?.claims;
  if (error || !claims?.sub) throw sinSesion();
  return { userId: claims.sub, email: typeof claims.email === "string" ? claims.email : null, token };
}
