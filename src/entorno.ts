/** Variables y servicios que Cloudflare le pasa al Worker (wrangler.jsonc + secretos). */
export type Entorno = {
  /** `local`, `test` o `produccion`. */
  BUILDON_ENV?: string;
  /** Dirección de la app de este ambiente (CORS). */
  APP_PUBLIC_URL?: string;
  SUPABASE_URL: string;
  /** Clave pública: con el token de la persona, la base aplica la RLS por rol. */
  SUPABASE_ANON_KEY: string;
  /** Solo para lo que la RLS no cubre (nombres del equipo, invitaciones). Nunca llega al navegador. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Un dato por pedido: ruta, estado, ms. */
  METRICAS?: AnalyticsEngineDataset;
  /** Límite por IP de las rutas sin sesión. */
  LIMITE_NAVEGADOR?: RateLimit;
  /** Límite amplio de los pedidos con sesión (una cuadrilla puede salir por la misma IP). */
  LIMITE_SESION?: RateLimit;
};

export function ambiente(env: Pick<Entorno, "BUILDON_ENV">): "local" | "test" | "produccion" {
  const valor = env.BUILDON_ENV?.trim();
  return valor === "local" || valor === "test" ? valor : "produccion";
}
