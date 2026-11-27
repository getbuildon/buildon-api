import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError } from "../error";

/**
 * Las filas que necesita Trabajo diario (lista de trabajos y «Cargar avance»), tal cual
 * salen de la base: la app las arma con la misma función que la pantalla de hoy
 * (lib/projects/armarTrabajoDiario.ts), así la regla de etiquetas y estados no se duplica.
 * Se lee con el token de la persona: la RLS decide qué filas ve.
 */
export async function leerTrabajoDeObra(db: SupabaseClient, obra: string) {
  const [pisos, unidades, grupos, asignaciones, avances] = await Promise.all([
    db.from("project_floors").select("id, name, identifier, level, sort_order").eq("project_id", obra).order("sort_order"),
    db.from("project_units").select("id, floor_id, code, name, sort_order").eq("project_id", obra).order("sort_order"),
    db
      .from("rubro_groups")
      .select("id, name, sort_order, rubros (id, name, sort_order, rubro_tasks (id, name, sort_order, weight_percent))")
      .eq("project_id", obra)
      .order("sort_order"),
    db.from("unit_task_assignments").select("unit_id, rubro_task_id").eq("project_id", obra),
    db.rpc("latest_progress_entries", { p_project_id: obra }),
  ]);
  if (pisos.error || unidades.error || grupos.error || asignaciones.error || avances.error) {
    throw new ApiError(502, "base", "No pudimos leer el trabajo de la obra. Probá de nuevo.");
  }

  const asignacionesPorUnidad: Record<string, string[]> = {};
  for (const fila of (asignaciones.data ?? []) as { unit_id: string; rubro_task_id: string }[]) {
    (asignacionesPorUnidad[fila.unit_id] ??= []).push(fila.rubro_task_id);
  }

  // Del último avance solo van las columnas que usa la pantalla (sin comentarios ni autor).
  const ultimos = ((avances.data ?? []) as Record<string, unknown>[]).map((a) => ({
    id: a.id,
    unit_id: a.unit_id,
    floor_id: a.floor_id,
    task_id: a.task_id,
    status: a.status,
    progress_state: a.progress_state,
    submitted_at: a.submitted_at,
    created_at: a.created_at,
  }));

  return {
    pisos: pisos.data ?? [],
    unidades: unidades.data ?? [],
    grupos: grupos.data ?? [],
    asignaciones: asignacionesPorUnidad,
    avances: ultimos,
  };
}
