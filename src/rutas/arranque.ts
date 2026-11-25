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
  empresa: { id: string; nombre: string; logoUrl: string | null } | null;
  portadaUrl: string | null;
  acceso: AccesoAObra;
};

export type Arranque = {
  persona: { id: string; email: string | null; nombre: string | null; apellido: string | null; avatarUrl: string | null };
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

export async function leerArranque(db: SupabaseClient, userId: string, email: string | null): Promise<Arranque> {
  const [perfilRes, empresasRes, miembrosRes, clienteRes] = await Promise.all([
    db.from("profiles").select("first_name, last_name, avatar_url, email").eq("id", userId).maybeSingle(),
    db
      .from("company_members")
      .select("role, company:companies ( id, name, logo_url )")
      .eq("user_id", userId)
      .eq("status", "active"),
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
