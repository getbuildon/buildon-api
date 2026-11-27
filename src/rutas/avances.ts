import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ApiError } from "../error";

/**
 * Cargar avance: espejo de saveCargarAvance y registerProgressAttachments de la app
 * (app/project/[projectId]/trabajo-diario/actions.ts). Mismas validaciones.
 *
 * Pensado para la cola sin señal: la app inventa los ids de cada avance y de cada foto.
 * Si un envío se repite (se cortó la señal en el medio), los ids que ya están se saltean
 * y la respuesta es la misma: nunca se duplica nada.
 */

const uuid = z.string().uuid();

export const cuerpoDeAvance = z.object({
  /** Cuándo se cargó en el dispositivo (ISO). Ordena lo cargado sin señal. */
  hechoEn: z.string().datetime({ offset: true }),
  pisoId: uuid,
  rubroId: uuid,
  tareas: z
    .array(
      z.object({
        tareaId: uuid,
        estado: z.enum(["completed", "in_progress", "blocked"]),
        comentario: z.string().max(2000).nullable(),
        unidades: z.array(z.object({ unidadId: uuid, avanceId: uuid })).min(1).max(200),
      }),
    )
    .min(1)
    .max(200),
});
export type CuerpoDeAvance = z.infer<typeof cuerpoDeAvance>;

export const cuerpoDeAdjuntos = z.object({
  adjuntos: z
    .array(
      z.object({
        id: uuid,
        avanceId: uuid,
        ruta: z.string().min(1).max(500),
        nombre: z.string().min(1).max(300),
        tipo: z.string().min(1).max(100),
        tamano: z.number().int().nonnegative().max(25 * 1024 * 1024),
      }),
    )
    .min(1)
    .max(400),
});
export type CuerpoDeAdjuntos = z.infer<typeof cuerpoDeAdjuntos>;

const ESTADO_EN_LA_BASE = {
  completed: { progress_state: "completed", status: "submitted" },
  in_progress: { progress_state: "in_progress", status: "submitted" },
  blocked: { progress_state: "in_progress", status: "rejected" },
} as const;

/** Una tarea ya terminada en una unidad no se vuelve a cargar (como la app). */
const estaCerrada = (status: string, progressState: string) => progressState === "completed" || status === "approved";

const MINUTO = 60_000;
const DIAS_HACIA_ATRAS = 30;

/** La hora del dispositivo vale si es razonable; si no (reloj roto), la del servidor. */
export function horaDeCarga(hechoEn: string, ahora: Date): string {
  const t = new Date(hechoEn).getTime();
  const valida = Number.isFinite(t) && t <= ahora.getTime() + 5 * MINUTO && t >= ahora.getTime() - DIAS_HACIA_ATRAS * 24 * 60 * MINUTO;
  return new Date(valida ? t : ahora.getTime()).toISOString();
}

const falla = (mensaje: string) => new ApiError(400, "invalido", mensaje);

export async function guardarAvance(
  db: SupabaseClient,
  obra: string,
  userId: string,
  cuerpo: CuerpoDeAvance,
  ahora: Date,
): Promise<{ avances: { id: string; unidadId: string; tareaId: string }[] }> {
  const pares = cuerpo.tareas.flatMap((t) => t.unidades.map((u) => ({ ...u, tarea: t })));
  const idsPedidos = pares.map((p) => p.avanceId);
  if (new Set(idsPedidos).size !== idsPedidos.length) throw falla("Hay avances repetidos en el envío.");
  const unidadesPedidas = [...new Set(pares.map((p) => p.unidadId))];
  const tareasPedidas = [...new Set(cuerpo.tareas.map((t) => t.tareaId))];

  // ¿Ya llegó antes? Los que existen no se vuelven a escribir.
  const yaEstan = await db.from("progress_entries").select("id, unit_id, task_id").eq("project_id", obra).in("id", idsPedidos);
  if (yaEstan.error) throw new ApiError(502, "base", "No pudimos guardar el avance. Probá de nuevo.");
  const existentes = new Set((yaEstan.data ?? []).map((f) => f.id as string));
  if (existentes.size === idsPedidos.length) {
    return { avances: pares.map((p) => ({ id: p.avanceId, unidadId: p.unidadId, tareaId: p.tarea.tareaId })) };
  }

  const [rubro, tareas, unidades, asignaciones, previos] = await Promise.all([
    db.from("rubros").select("id").eq("id", cuerpo.rubroId).eq("project_id", obra).maybeSingle(),
    db.from("rubro_tasks").select("id, rubro_id").eq("project_id", obra).in("id", tareasPedidas),
    db.from("project_units").select("id, floor_id").eq("project_id", obra).in("id", unidadesPedidas),
    db.from("unit_task_assignments").select("unit_id, rubro_task_id").eq("project_id", obra),
    db
      .from("progress_entries")
      .select("id, unit_id, task_id, status, progress_state, created_at")
      .eq("project_id", obra)
      .in("unit_id", unidadesPedidas)
      .in("task_id", tareasPedidas)
      .order("created_at", { ascending: false }),
  ]);
  if (rubro.error || tareas.error || unidades.error || asignaciones.error || previos.error) {
    throw new ApiError(502, "base", "No pudimos guardar el avance. Probá de nuevo.");
  }
  if (!rubro.data) throw falla("Rubro no encontrado.");

  const delRubro = new Set((tareas.data ?? []).filter((t) => t.rubro_id === cuerpo.rubroId).map((t) => t.id as string));
  if (tareasPedidas.some((t) => !delRubro.has(t))) throw falla("Hay tareas inválidas para el rubro seleccionado.");

  const filasDeUnidades = unidades.data ?? [];
  if (filasDeUnidades.length !== unidadesPedidas.length) throw falla("Una o más unidades no son válidas.");
  if (filasDeUnidades.some((u) => u.floor_id !== cuerpo.pisoId)) throw falla("Las unidades deben pertenecer al nivel seleccionado.");

  const asignadas = new Map<string, Set<string>>();
  for (const a of asignaciones.data ?? []) {
    const set = asignadas.get(a.unit_id as string) ?? new Set<string>();
    set.add(a.rubro_task_id as string);
    asignadas.set(a.unit_id as string, set);
  }
  const hayAsignaciones = asignadas.size > 0;
  if (hayAsignaciones && pares.some((p) => !asignadas.get(p.unidadId)?.has(p.tarea.tareaId))) {
    throw falla("Hay tareas no asignadas a alguna unidad seleccionada.");
  }

  // El último avance de cada tarea en cada unidad (sin contar los de este mismo envío).
  const cerradas = new Set<string>();
  const vistas = new Set<string>();
  for (const f of previos.data ?? []) {
    if (existentes.has(f.id as string)) continue;
    const clave = `${f.unit_id}:${f.task_id}`;
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    if (estaCerrada(f.status as string, f.progress_state as string)) cerradas.add(clave);
  }

  const hora = horaDeCarga(cuerpo.hechoEn, ahora);
  const filas = pares
    .filter((p) => !existentes.has(p.avanceId) && !cerradas.has(`${p.unidadId}:${p.tarea.tareaId}`))
    .map((p) => ({
      id: p.avanceId,
      project_id: obra,
      floor_id: cuerpo.pisoId,
      unit_id: p.unidadId,
      category_id: cuerpo.rubroId,
      task_id: p.tarea.tareaId,
      created_by: userId,
      ...ESTADO_EN_LA_BASE[p.tarea.estado],
      comment: p.tarea.comentario?.trim() || null,
      submitted_at: hora,
    }));

  if (filas.length === 0 && existentes.size === 0) {
    throw falla("Las tareas seleccionadas ya están completadas para estas unidades.");
  }

  if (filas.length > 0) {
    // ON CONFLICT DO NOTHING: si otro envío igual ganó la carrera, no se duplica.
    const insertado = await db.from("progress_entries").upsert(filas, { onConflict: "id", ignoreDuplicates: true });
    if (insertado.error) throw new ApiError(502, "base", "No pudimos guardar el avance. Probá de nuevo.");
  }

  const guardados = new Set([...existentes, ...filas.map((f) => f.id)]);
  return {
    avances: pares
      .filter((p) => guardados.has(p.avanceId))
      .map((p) => ({ id: p.avanceId, unidadId: p.unidadId, tareaId: p.tarea.tareaId })),
  };
}

export async function registrarAdjuntos(
  db: SupabaseClient,
  obra: string,
  userId: string,
  cuerpo: CuerpoDeAdjuntos,
): Promise<{ adjuntos: number }> {
  // Las fotos de avance se guardan en {obra}/progress/…: no se aceptan rutas de otra obra.
  if (cuerpo.adjuntos.some((a) => !a.ruta.startsWith(`${obra}/progress/`) || a.ruta.includes(".."))) {
    throw falla("Hay fotos con una ubicación inválida.");
  }
  const avancesPedidos = [...new Set(cuerpo.adjuntos.map((a) => a.avanceId))];
  const [avances, obraFila] = await Promise.all([
    db.from("progress_entries").select("id").eq("project_id", obra).in("id", avancesPedidos),
    db.from("projects").select("company_id").eq("id", obra).maybeSingle(),
  ]);
  if (avances.error || obraFila.error) throw new ApiError(502, "base", "No pudimos guardar las fotos. Probá de nuevo.");
  if ((avances.data ?? []).length !== avancesPedidos.length) throw falla("Uno o más avances no son válidos.");
  if (!obraFila.data) throw falla("Proyecto no encontrado.");

  const filas = cuerpo.adjuntos.map((a) => ({
    id: a.id,
    company_id: obraFila.data!.company_id,
    project_id: obra,
    uploaded_by: userId,
    entity_type: "progress_entry",
    entity_id: a.avanceId,
    file_url: a.ruta,
    file_name: a.nombre,
    file_type: a.tipo,
    file_size: a.tamano,
  }));
  const insertado = await db.from("attachments").upsert(filas, { onConflict: "id", ignoreDuplicates: true });
  if (insertado.error) throw new ApiError(502, "base", "No pudimos guardar las fotos. Probá de nuevo.");
  return { adjuntos: filas.length };
}

/**
 * Cambiar el estado de un trabajo cargado: espejo de updateTrabajoDiarioTask. No se edita
 * la fila: se suma un avance nuevo para la misma tarea y unidad (queda el historial).
 * Una tarea certificada solo la cambia quien puede certificar.
 */
export async function cambiarEstado(
  db: SupabaseClient,
  obra: string,
  userId: string,
  avanceId: string,
  cuerpo: { nuevoId: string; hechoEn: string; estado: "completed" | "in_progress" | "blocked"; comentario: string | null },
  acceso: { unidades: string[] | null; puedeCertificar: boolean },
  ahora: Date,
): Promise<{ avanceId: string }> {
  const ya = await db.from("progress_entries").select("id").eq("project_id", obra).eq("id", cuerpo.nuevoId).maybeSingle();
  if (ya.error) throw new ApiError(502, "base", "No pudimos guardar el cambio. Probá de nuevo.");
  if (ya.data) return { avanceId: cuerpo.nuevoId };

  const base = await db
    .from("progress_entries")
    .select("id, floor_id, unit_id, category_id, task_id")
    .eq("project_id", obra)
    .eq("id", avanceId)
    .maybeSingle();
  if (base.error) throw new ApiError(502, "base", "No pudimos guardar el cambio. Probá de nuevo.");
  const e = base.data;
  if (!e || !e.unit_id || !e.task_id || !e.floor_id) throw new ApiError(404, "no_existe", "Avance no encontrado.");
  if (acceso.unidades !== null && !acceso.unidades.includes(e.unit_id as string)) {
    throw new ApiError(403, "sin_permiso", "No tenés permiso para editar tareas de esta unidad.");
  }

  const [ultimo, asignaciones] = await Promise.all([
    db.rpc("latest_progress_entries", { p_project_id: obra, p_unit_id: e.unit_id }),
    db.from("unit_task_assignments").select("unit_id, rubro_task_id").eq("project_id", obra),
  ]);
  if (ultimo.error || asignaciones.error) throw new ApiError(502, "base", "No pudimos guardar el cambio. Probá de nuevo.");
  const certificada = ((ultimo.data ?? []) as { task_id: string; status: string }[]).some(
    (a) => a.task_id === e.task_id && a.status === "approved",
  );
  if (certificada && !acceso.puedeCertificar) {
    throw new ApiError(403, "certificada", "No tenés permiso para cambiar el estado de una tarea certificada.");
  }
  const filas = (asignaciones.data ?? []) as { unit_id: string; rubro_task_id: string }[];
  if (filas.length > 0 && !filas.some((a) => a.unit_id === e.unit_id && a.rubro_task_id === e.task_id)) {
    throw falla("La tarea no está asignada a esta unidad.");
  }

  const insertado = await db.from("progress_entries").upsert(
    {
      id: cuerpo.nuevoId,
      project_id: obra,
      floor_id: e.floor_id,
      unit_id: e.unit_id,
      category_id: e.category_id,
      task_id: e.task_id,
      created_by: userId,
      ...ESTADO_EN_LA_BASE[cuerpo.estado],
      comment: cuerpo.comentario?.trim() || null,
      submitted_at: horaDeCarga(cuerpo.hechoEn, ahora),
    },
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (insertado.error) throw new ApiError(502, "base", "No pudimos guardar el cambio. Probá de nuevo.");
  return { avanceId: cuerpo.nuevoId };
}
