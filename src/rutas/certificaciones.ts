import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "../error";

/**
 * Certificaciones: espejo de getCertificacionesData y certifyProgressEntries de la app
 * (app/project/[projectId]/certificaciones/actions.ts). La lectura manda las filas; la
 * app arma la lista con lib/projects/armarCertificaciones.ts (la misma función que la
 * server action). Los nombres salen con el cliente de servicio, limitados a esta obra.
 */

function nombreParaMostrar(ficha: { first_name?: string | null; last_name?: string | null } | undefined, email?: string | null) {
  const nombre = ficha?.first_name?.trim();
  const apellido = ficha?.last_name?.trim();
  if (nombre && apellido) return `${nombre} ${apellido}`;
  return nombre || apellido || email?.trim() || "Usuario";
}

export async function nombresDeLaObra(servicio: SupabaseClient, obra: string, personas: string[]) {
  const nombres: Record<string, string> = {};
  const ids = [...new Set(personas.filter(Boolean))];
  if (ids.length === 0) return nombres;
  const [fichas, perfiles] = await Promise.all([
    servicio.from("project_members").select("user_id, first_name, last_name").eq("project_id", obra).in("user_id", ids),
    servicio.from("profiles").select("id, email").in("id", ids),
  ]);
  const fichaDe = new Map((fichas.data ?? []).map((f) => [f.user_id as string, f]));
  const emailDe = new Map((perfiles.data ?? []).map((p) => [p.id as string, p.email as string | null]));
  for (const id of ids) nombres[id] = nombreParaMostrar(fichaDe.get(id), emailDe.get(id));
  return nombres;
}

export async function leerCertificaciones(db: SupabaseClient, servicio: SupabaseClient, obra: string, puedeCertificar: boolean) {
  const [pisos, unidades, asignaciones, grupos, avances] = await Promise.all([
    db.from("project_floors").select("id, name, identifier, sort_order").eq("project_id", obra).order("sort_order"),
    db.from("project_units").select("id, floor_id, code, sort_order").eq("project_id", obra).order("sort_order"),
    db.from("unit_task_assignments").select("unit_id, rubro_task_id").eq("project_id", obra),
    db.from("rubro_groups").select("id, sort_order, rubros (id, name, sort_order, rubro_tasks (id, name, sort_order))").eq("project_id", obra).order("sort_order"),
    db.rpc("latest_progress_entries", { p_project_id: obra, p_statuses: ["submitted", "approved"] }),
  ]);
  if (pisos.error || unidades.error || asignaciones.error || grupos.error || avances.error) {
    throw new ApiError(502, "base", "No pudimos leer las certificaciones. Probá de nuevo.");
  }
  const filas = ((avances.data ?? []) as Record<string, unknown>[]).map((a) => ({
    id: a.id as string,
    unit_id: a.unit_id as string | null,
    floor_id: a.floor_id as string | null,
    task_id: a.task_id as string,
    status: a.status as string,
    progress_state: a.progress_state as string,
    comment: a.comment as string | null,
    created_by: a.created_by as string,
    submitted_at: a.submitted_at as string | null,
    created_at: a.created_at as string,
  }));
  const certificados = filas.filter((f) => f.status === "approved").map((f) => f.id);
  const validaciones = certificados.length
    ? await db
        .from("progress_validations")
        .select("progress_entry_id, validated_at, validated_by, comment")
        .in("progress_entry_id", certificados)
        .eq("decision", "approved")
        .order("validated_at", { ascending: false })
    : { data: [], error: null };
  if (validaciones.error) throw new ApiError(502, "base", "No pudimos leer las certificaciones. Probá de nuevo.");
  const filasDeValidaciones = (validaciones.data ?? []) as { validated_by: string }[];

  const asignacionesPorUnidad: Record<string, string[]> = {};
  for (const a of (asignaciones.data ?? []) as { unit_id: string; rubro_task_id: string }[]) {
    (asignacionesPorUnidad[a.unit_id] ??= []).push(a.rubro_task_id);
  }
  return {
    pisos: pisos.data ?? [],
    unidades: unidades.data ?? [],
    grupos: grupos.data ?? [],
    asignaciones: asignacionesPorUnidad,
    avances: filas,
    validaciones: validaciones.data ?? [],
    nombres: await nombresDeLaObra(servicio, obra, [...filas.map((f) => f.created_by), ...filasDeValidaciones.map((v) => v.validated_by)]),
    puedeCertificar,
  };
}

export const cuerpoDeCertificacion = z.object({
  hechoEn: z.string().datetime({ offset: true }),
  certificaciones: z
    .array(z.object({ avanceId: z.string().uuid(), validacionId: z.string().uuid(), nota: z.string().max(2000).nullable() }))
    .min(1)
    .max(500),
});
export type CuerpoDeCertificacion = z.infer<typeof cuerpoDeCertificacion>;

/**
 * Certifica avances completados. Pensado para la cola: cada certificación lleva un id que
 * pone la app. Repetir el envío no duplica: lo ya certificado se cuenta como hecho.
 * Si alguno cambió mientras tanto (ya no está completado), se avisa y no se certifica nada.
 */
export async function certificar(
  db: SupabaseClient,
  obra: string,
  userId: string,
  cuerpo: CuerpoDeCertificacion,
  hora: string,
): Promise<{ certificadas: number }> {
  const ids = [...new Set(cuerpo.certificaciones.map((c) => c.avanceId))];
  const avances = await db.from("progress_entries").select("id, status, progress_state").eq("project_id", obra).in("id", ids);
  if (avances.error) throw new ApiError(502, "base", "No pudimos certificar. Probá de nuevo.");
  const filas = (avances.data ?? []) as { id: string; status: string; progress_state: string }[];
  if (filas.length !== ids.length) throw new ApiError(400, "invalido", "Una o más tareas no son válidas.");
  if (filas.some((f) => f.status !== "approved" && !(f.status === "submitted" && f.progress_state === "completed"))) {
    throw new ApiError(409, "cambio", "Alguna tarea cambió de estado y ya no está completada. Revisala antes de certificar.");
  }

  // Primero las certificaciones (con su id: si ya estaban, no se repiten); después el estado.
  const validaciones = cuerpo.certificaciones.map((c) => ({
    id: c.validacionId,
    progress_entry_id: c.avanceId,
    validated_by: userId,
    decision: "approved",
    comment: c.nota?.trim() || null,
    validated_at: hora,
  }));
  const pendientes = new Set(filas.filter((f) => f.status !== "approved").map((f) => f.id));
  const nuevas = validaciones.filter((v) => pendientes.has(v.progress_entry_id));
  if (nuevas.length > 0) {
    const insertadas = await db.from("progress_validations").upsert(nuevas, { onConflict: "id", ignoreDuplicates: true });
    if (insertadas.error) throw new ApiError(502, "base", "No pudimos certificar. Probá de nuevo.");
    const actualizadas = await db
      .from("progress_entries")
      .update({ status: "approved", progress_state: "completed" })
      .eq("project_id", obra)
      .in("id", [...pendientes]);
    if (actualizadas.error) throw new ApiError(502, "base", "No pudimos certificar. Probá de nuevo.");
  }
  return { certificadas: ids.length };
}
