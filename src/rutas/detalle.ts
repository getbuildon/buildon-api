import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "../error";
import type { AccesoAObra } from "../permisos";

/**
 * El detalle de un trabajo cargado: espejo de getTrabajoDiarioTaskDetail de la app. Manda
 * las filas; la app arma la pantalla con lib/projects/armarDetalleDeTrabajo.ts (la misma
 * función que la server action). Las filas se leen con el token de la persona; solo los
 * nombres de autores salen con el cliente de servicio, limitados a esta obra.
 */
const BUCKET = "progress-photos";
const UNA_HORA = 3600;

const uno = <T>(valor: T | T[] | null | undefined): T | null => (Array.isArray(valor) ? (valor[0] ?? null) : (valor ?? null));

/** Mismo criterio que formatProjectMemberDisplayName de la app. */
function nombreParaMostrar(ficha: { first_name?: string | null; last_name?: string | null } | undefined, email?: string | null) {
  const nombre = ficha?.first_name?.trim();
  const apellido = ficha?.last_name?.trim();
  if (nombre && apellido) return `${nombre} ${apellido}`;
  return nombre || apellido || email?.trim() || "Usuario";
}

/** Puede ver el detalle: carga, edita o certifica, o ve el avance de esa unidad. */
export function puedeVerDetalle(acceso: AccesoAObra, unidad: string): boolean {
  const p = acceso.permisos;
  if (p.loadProgress === true || p.editTasks === true || p.certifyTasks === true) return true;
  if (acceso.unidades === null) return p.viewDetailedProgress === true;
  return acceso.unidades.includes(unidad);
}

export async function leerDetalleDeAvance(
  db: SupabaseClient,
  servicio: SupabaseClient,
  obra: string,
  avanceId: string,
  acceso: AccesoAObra,
) {
  const fila = await db
    .from("progress_entries")
    .select(
      "id, unit_id, floor_id, task_id, category_id, status, progress_state, comment, created_at, submitted_at, rubros:category_id (name), rubro_tasks:task_id (name), project_floors:floor_id (name, identifier)",
    )
    .eq("project_id", obra)
    .eq("id", avanceId)
    .maybeSingle();
  if (fila.error) throw new ApiError(502, "base", "No pudimos leer el trabajo. Probá de nuevo.");
  const avance = fila.data;
  if (!avance || !avance.unit_id || !avance.task_id || !puedeVerDetalle(acceso, avance.unit_id as string)) {
    throw new ApiError(404, "no_existe", "No encontramos ese trabajo o no tenés acceso.");
  }
  const veHistorial = acceso.permisos.viewAuditLog === true;

  const [unidades, historial] = await Promise.all([
    avance.floor_id
      ? db.from("project_units").select("id, code").eq("project_id", obra).eq("floor_id", avance.floor_id).order("sort_order")
      : Promise.resolve({ data: null, error: null }),
    veHistorial
      ? db
          .from("progress_entries")
          .select("id, status, progress_state, comment, created_at, submitted_at, created_by")
          .eq("project_id", obra)
          .eq("unit_id", avance.unit_id)
          .eq("task_id", avance.task_id)
          .order("created_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (unidades.error || historial.error) throw new ApiError(502, "base", "No pudimos leer el trabajo. Probá de nuevo.");

  const filasDeHistorial = (historial.data ?? []) as { id: string; created_by: string }[];
  const ids = [...new Set([...filasDeHistorial.map((h) => h.id), avance.id as string])];
  const [adjuntos, validaciones] = await Promise.all([
    db
      .from("attachments")
      .select("id, entity_id, file_url, file_name, created_at")
      .eq("project_id", obra)
      .eq("entity_type", "progress_entry")
      .in("entity_id", ids)
      .order("created_at"),
    filasDeHistorial.length > 0
      ? db
          .from("progress_validations")
          .select("id, progress_entry_id, validated_by, validated_at, comment")
          .in("progress_entry_id", filasDeHistorial.map((h) => h.id))
          .eq("decision", "approved")
          .order("validated_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  // Fotos: un enlace firmado por una hora (como hoy). Sin enlace, la foto no se muestra.
  const porAvance: Record<string, { id: string; fileName: string; signedUrl: string }[]> = {};
  const filasDeAdjuntos = (adjuntos.data ?? []) as { id: string; entity_id: string; file_url: string; file_name: string }[];
  if (filasDeAdjuntos.length > 0) {
    const firmados = await db.storage.from(BUCKET).createSignedUrls([...new Set(filasDeAdjuntos.map((a) => a.file_url))], UNA_HORA);
    const urlDe = new Map((firmados.data ?? []).filter((f) => f.signedUrl).map((f) => [f.path ?? "", f.signedUrl]));
    for (const a of filasDeAdjuntos) {
      const url = urlDe.get(a.file_url);
      if (url) (porAvance[a.entity_id] ??= []).push({ id: a.id, fileName: a.file_name, signedUrl: url });
    }
  }

  const filasDeValidaciones = (validaciones.data ?? []) as { id: string; validated_by: string; validated_at: string; comment: string | null }[];
  const personas = [...new Set([...filasDeHistorial.map((h) => h.created_by), ...filasDeValidaciones.map((v) => v.validated_by)])];
  const nombres: Record<string, string> = {};
  if (personas.length > 0) {
    const [fichas, perfiles] = await Promise.all([
      servicio.from("project_members").select("user_id, first_name, last_name").eq("project_id", obra).in("user_id", personas),
      servicio.from("profiles").select("id, email").in("id", personas),
    ]);
    const fichaDe = new Map((fichas.data ?? []).map((f) => [f.user_id as string, f]));
    const emailDe = new Map((perfiles.data ?? []).map((p) => [p.id as string, p.email as string | null]));
    for (const id of personas) nombres[id] = nombreParaMostrar(fichaDe.get(id), emailDe.get(id));
  }

  const piso = uno(avance.project_floors as unknown as { name: string; identifier: string | null } | null);
  return {
    avance: {
      id: avance.id,
      unit_id: avance.unit_id,
      // Para armar un cambio de estado sin señal (la cola necesita piso, tarea y rubro).
      floor_id: avance.floor_id,
      task_id: avance.task_id,
      category_id: avance.category_id,
      status: avance.status,
      progress_state: avance.progress_state,
      comment: avance.comment,
      created_at: avance.created_at,
      submitted_at: avance.submitted_at,
      rubro: uno(avance.rubros as unknown as { name: string } | null)?.name ?? null,
      tarea: uno(avance.rubro_tasks as unknown as { name: string } | null)?.name ?? null,
      piso: piso ? { name: piso.name, identifier: piso.identifier ?? null } : null,
    },
    unidadesDelPiso: unidades.data,
    historial: historial.data ?? [],
    validaciones: filasDeValidaciones,
    adjuntos: porAvance,
    nombres,
    veHistorial,
  };
}

export const cuerpoDeCambio = z.object({
  /** Id del avance nuevo (lo pone la app: repetir el envío no duplica). */
  nuevoId: z.string().uuid(),
  hechoEn: z.string().datetime({ offset: true }),
  estado: z.enum(["completed", "in_progress", "blocked"]),
  comentario: z.string().max(2000).nullable(),
});
export type CuerpoDeCambio = z.infer<typeof cuerpoDeCambio>;
