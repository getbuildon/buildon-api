import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../error";
import { resolverAcceso, type AccesoAObra, type TipoDeUsuario } from "../permisos";

/**
 * GET /arranque: todo lo que la app necesita al abrir, en un solo pedido.
 * Hoy el inicio hace 4–6 server actions (shell, obras, progreso, empresa); esto lo
 * reemplaza. Lo lee con el token de la persona: la RLS por rol decide qué ve.
 *
 * Con `?desde=<version>` responde `{ sinCambios: true }` si nada cambió, y la app
 * sigue con la copia que guardó en el dispositivo.
 */
export type ObraDelArranque = {
  id: string;
  nombre: string;
  direccion: string | null;
  estado: string;
  pisos: number;
  empresa: { id: string; nombre: string; logoUrl: string | null } | null;
  portadaUrl: string | null;
  acceso: AccesoAObra;
};

export type Arranque = {
  persona: {
    id: string;
    email: string | null;
    nombre: string | null;
    apellido: string | null;
    avatarUrl: string | null;
    /** Solo decide si se muestra el acceso; el backoffice valida de nuevo en su servidor. */
    veBackoffice: boolean;
  };
  empresas: { id: string; nombre: string; logoUrl: string | null; rol: string }[];
  obras: ObraDelArranque[];
};

type FilaObra = {
  id: string;
  name: string;
  location: string | null;
  status: string | null;
  company_id: string | null;
  image_url: string | null;
  cover_url: string | null;
  company: { id: string; name: string; logo_url: string | null } | { id: string; name: string; logo_url: string | null }[] | null;
};

const COLUMNAS_OBRA = "id, name, location, status, company_id, image_url, cover_url, company:companies ( id, name, logo_url )";

function una<T>(valor: T | T[] | null | undefined): T | null {
  if (valor == null) return null;
  return Array.isArray(valor) ? (valor[0] ?? null) : valor;
}

function fallo(error: { message: string } | null, que: string): void {
  if (error) throw new ApiError(502, "base", `No pudimos leer ${que}. Probá de nuevo.`);
}

export function esDeBackoffice(lista: string | undefined, email: string | null): boolean {
  if (!email || !lista?.trim()) return false;
  const permitidos = lista.split(",").map((e) => e.trim().toLowerCase());
  return permitidos.includes(email.trim().toLowerCase());
}

export async function leerArranque(
  db: SupabaseClient,
  userId: string,
  email: string | null,
  backoffice?: string,
): Promise<Arranque> {
  const [perfilRes, empresasRes, miembrosRes, clienteRes] = await Promise.all([
    db.from("profiles").select("first_name, last_name, avatar_url, email").eq("id", userId).maybeSingle(),
    db
      .from("company_members")
      .select("role, company:companies ( id, name, logo_url )")
      .eq("user_id", userId)
      .eq("status", "active")
      // La más nueva primero, como la app: es la empresa que muestra el inicio.
      .order("created_at", { ascending: false }),
    db
      .from("project_members")
      .select(`project_id, user_type:user_types ( slug ), project:projects ( ${COLUMNAS_OBRA} )`)
      .eq("user_id", userId)
      .eq("is_active", true),
    db
      .from("unit_clients")
      .select(`unit_id, unit:project_units!inner ( project_id, project:projects ( ${COLUMNAS_OBRA} ) )`)
      .eq("user_id", userId)
      .eq("status", "active"),
  ]);
  fallo(perfilRes.error, "tu perfil");
  fallo(empresasRes.error, "tus empresas");
  fallo(miembrosRes.error, "tus obras");
  fallo(clienteRes.error, "tus unidades");

  const empresas = (empresasRes.data ?? []).flatMap((fila) => {
    const empresa = una(fila.company as FilaObra["company"]);
    return empresa ? [{ id: empresa.id, nombre: empresa.name, logoUrl: empresa.logo_url, rol: String(fila.role) }] : [];
  });
  const empresasAdmin = empresas.filter((e) => e.rol === "owner" || e.rol === "admin").map((e) => e.id);

  // Obras de las empresas donde es owner/admin (ven todas, aunque no estén en el equipo).
  let obrasDeEmpresa: FilaObra[] = [];
  if (empresasAdmin.length > 0) {
    const res = await db.from("projects").select(COLUMNAS_OBRA).in("company_id", empresasAdmin);
    fallo(res.error, "las obras de tu empresa");
    obrasDeEmpresa = (res.data ?? []) as unknown as FilaObra[];
  }

  const filas = new Map<string, FilaObra>();
  const tipoPorObra = new Map<string, TipoDeUsuario>();
  for (const m of miembrosRes.data ?? []) {
    const obra = una(m.project as unknown as FilaObra | FilaObra[] | null);
    if (!obra) continue;
    filas.set(obra.id, obra);
    const slug = una(m.user_type as { slug: string } | { slug: string }[] | null)?.slug;
    if (slug === "owner" || slug === "admin" || slug === "supervisor" || slug === "operador" || slug === "cliente") {
      tipoPorObra.set(obra.id, slug);
    }
  }
  const unidadesPorObra = new Map<string, string[]>();
  for (const c of clienteRes.data ?? []) {
    const unidad = una(c.unit as unknown as { project_id: string; project: FilaObra | FilaObra[] | null } | null);
    const obra = una(unidad?.project ?? null);
    if (!unidad || !obra) continue;
    filas.set(obra.id, obra);
    unidadesPorObra.set(obra.id, [...(unidadesPorObra.get(obra.id) ?? []), c.unit_id as string]);
  }
  for (const obra of obrasDeEmpresa) filas.set(obra.id, obra);

  // Cantidad de pisos por obra (dato de la tarjeta del inicio).
  const pisosPorObra = new Map<string, number>();
  if (filas.size > 0) {
    const res = await db.from("project_floors").select("project_id").in("project_id", [...filas.keys()]);
    fallo(res.error, "los pisos de tus obras");
    for (const fila of res.data ?? []) {
      const id = fila.project_id as string;
      pisosPorObra.set(id, (pisosPorObra.get(id) ?? 0) + 1);
    }
  }

  const obras: ObraDelArranque[] = [];
  for (const obra of filas.values()) {
    const acceso = resolverAcceso({
      tipoEnObra: tipoPorObra.get(obra.id) ?? null,
      adminDeEmpresa: obra.company_id != null && empresasAdmin.includes(obra.company_id),
      unidadesDeCliente: unidadesPorObra.get(obra.id) ?? [],
    });
    if (!acceso) continue;
    const empresa = una(obra.company);
    obras.push({
      id: obra.id,
      nombre: obra.name,
      direccion: obra.location?.trim() || null,
      estado: obra.status ?? "active",
      pisos: pisosPorObra.get(obra.id) ?? 0,
      empresa: empresa ? { id: empresa.id, nombre: empresa.name, logoUrl: empresa.logo_url } : null,
      portadaUrl: obra.image_url ?? obra.cover_url ?? null,
      acceso,
    });
  }
  obras.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  const perfil = perfilRes.data;
  return {
    persona: {
      id: userId,
      email: perfil?.email ?? email,
      nombre: perfil?.first_name ?? null,
      apellido: perfil?.last_name ?? null,
      avatarUrl: perfil?.avatar_url ?? null,
      veBackoffice: esDeBackoffice(backoffice, perfil?.email ?? email),
    },
    empresas,
    obras,
  };
}

/** Versión del contenido: si es igual a la que tiene la app, no hace falta mandarlo de nuevo. */
export async function versionDe(datos: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(datos));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash).slice(0, 12)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * El acceso de la persona a UNA obra, en una sola tanda de consultas en paralelo (en vez
 * de leer todas sus obras como el arranque). Mismo criterio que leerArranque: tipo en el
 * equipo, owner/admin de la empresa de la obra, o cliente de alguna unidad.
 * null: no tiene acceso (o la obra no existe; la RLS tampoco se la deja ver).
 */
export async function accesoAObra(
  db: SupabaseClient,
  userId: string,
  obraId: string,
): Promise<{ id: string; acceso: AccesoAObra } | null> {
  const [obraRes, miembroRes, empresasRes, clienteRes] = await Promise.all([
    db.from("projects").select("id, company_id").eq("id", obraId).maybeSingle(),
    db
      .from("project_members")
      .select("user_type:user_types ( slug )")
      .eq("project_id", obraId)
      .eq("user_id", userId)
      .eq("is_active", true),
    db.from("company_members").select("company_id, role").eq("user_id", userId).eq("status", "active"),
    db
      .from("unit_clients")
      .select("unit_id, unit:project_units!inner ( project_id )")
      .eq("user_id", userId)
      .eq("status", "active")
      .eq("unit.project_id", obraId),
  ]);
  fallo(obraRes.error, "la obra");
  fallo(miembroRes.error, "tu lugar en la obra");
  fallo(empresasRes.error, "tus empresas");
  fallo(clienteRes.error, "tus unidades");
  const obra = obraRes.data;
  if (!obra) return null;

  let tipoEnObra: TipoDeUsuario | null = null;
  for (const m of miembroRes.data ?? []) {
    const slug = una(m.user_type as { slug: string } | { slug: string }[] | null)?.slug;
    if (slug === "owner" || slug === "admin" || slug === "supervisor" || slug === "operador" || slug === "cliente") tipoEnObra = slug;
  }
  const adminDeEmpresa =
    obra.company_id != null &&
    (empresasRes.data ?? []).some((e) => e.company_id === obra.company_id && (e.role === "owner" || e.role === "admin"));
  const unidadesDeCliente = (clienteRes.data ?? []).map((c) => c.unit_id as string);

  const acceso = resolverAcceso({ tipoEnObra, adminDeEmpresa, unidadesDeCliente });
  return acceso ? { id: obra.id as string, acceso } : null;
}
